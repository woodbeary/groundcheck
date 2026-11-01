import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { attachOnce } from "../src/encompass/attach.ts";
import { intake, verifyElli, verifyOcrolus } from "../src/encompass/intake.ts";
import { Ledger } from "../src/encompass/ledger.ts";
import { DOC, MockEncompass, type LoanEvent } from "../src/encompass/mock.ts";
import { dailyCounts, reconcileLoan, type ReconcileDeps } from "../src/encompass/reconcile.ts";
import { CONTAINER, MockOcrolus, OCROLUS_DOC, UNSUPPORTED_MARK, nextPushTry, signOcrolus } from "../src/ocrolus/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "groundcheck-reconcile-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const LOAN = "loan-synthetic-0202";
const KEY = "Synthetic-Signing-Key-0123456789!abcdef";
const doc = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`);

function world(options: { documentConversion?: boolean } = {}) {
  const enc = new MockEncompass(options);
  const ocrolus = new MockOcrolus();
  ocrolus.books.push({ uuid: "book-synthetic-0202", name: "Sample SYN-0202", loan_guid: LOAN, loan_number: "SYN-0202", docs: [] });
  ocrolus.books.push({ uuid: "book-synthetic-0303", name: "Sample SYN-0202", loan_guid: "loan-synthetic-0303", loan_number: "SYN-0303", docs: [] });
  const ledger = new Ledger(join(dir, `${randomUUID()}.db`));
  const heard: LoanEvent[] = [];
  const subscriptionId = enc.subscribe({ endpoint: "https://connector.example.invalid/hooks", resource: "Loan", events: ["attachment"], signingkey: KEY }, (e) => {
    heard.push(e);
    return 200;
  });
  const deps = (now: number): ReconcileDeps => ({ api: enc, ocrolus, ledger, listSubscriptions: () => enc.listSubscriptions(), subscriptionId, now, stuckAfterSeconds: 3600 });
  return { enc, ocrolus, ledger, heard, deps };
}

describe(`the reconciler reads the eFolder back [docs: ${OCROLUS_DOC}/docs/encompass-classify and ${DOC}/reference/wbhks-retry-logic, checked 2026-11-01]`, () => {
  it("counts six documents confirmed and one UNKNOWN page to review after Ocrolus classifies them", async () => {
    const w = world();
    for (const name of ["rent schedule", "lease", "note", "tax bill", "insurance declarations", `blank scan ${UNSUPPORTED_MARK}`]) await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc(name), `${name}.pdf`);
    assert.equal(w.ocrolus.classify(w.enc, LOAN, 600, false), "pushed");
    const h = await reconcileLoan(w.deps(700), LOAN);
    assert.deepEqual([h.health, h.expected, h.confirmed, h.unknownPages, h.stuck.length], ["green", 6, 6, 1, 0]);
    assert.equal(h.containers[CONTAINER.complete], 6);
    assert.equal(h.book, "book-synthetic-0202");
  });

  it("turns red on a PUT that answered 200 and kept nothing, while every event says success", async () => {
    const w = world();
    for (const name of ["rent schedule", "lease", "note", "tax bill", "insurance", "association statement"]) await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc(name), `${name}.pdf`);
    w.enc.dropNextPut = true;
    const lied = await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc("late lease"), "late-lease.pdf");
    const everyPutAnswered200 = w.enc.calls["upload"] === 7;
    assert.ok(everyPutAnswered200, "an events-only health check would stay green");
    assert.equal(lied.state, "unconfirmed_never_resubmitted");
    const h = await reconcileLoan(w.deps(100), LOAN);
    assert.equal(h.health, "red");
    assert.equal(h.confirmed, 6);
    assert.match(h.reasons.join("; "), /1 attachment\(s\) unconfirmed/);
  });

  it("still sees a document whose webhook was discarded after three linear tries", async () => {
    const w = world();
    w.enc.subscriptions.length = 0;
    const lostId = w.enc.subscribe({ endpoint: "https://connector.example.invalid/hooks", resource: "Loan", events: ["attachment"], signingkey: KEY }, () => 503);
    await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc("lease"), "lease.pdf");
    const event = w.enc.emit(LOAN, "attachment", "processor-synthetic");
    assert.deepEqual(w.enc.deliveries.filter((d) => d.eventId === event.eventId).map((d) => d.atSeconds), [0, 20, 40]);
    assert.ok(w.enc.discarded.includes(event.eventId));
    const h = await reconcileLoan({ ...w.deps(10), subscriptionId: lostId }, LOAN);
    assert.equal(h.confirmed, 1);
  });

  it("notices when ICE has deleted its undeliverable subscription", async () => {
    const w = world();
    w.enc.subscriptions.length = 0;
    const id = w.enc.subscribe({ endpoint: "https://connector.example.invalid/hooks", resource: "Loan", events: ["attachment"], signingkey: KEY }, () => "timeout");
    w.enc.emit(LOAN, "attachment", "processor-synthetic");
    w.enc.reviewSubscriptions();
    const h = await reconcileLoan({ ...w.deps(10), subscriptionId: id }, LOAN);
    assert.equal(h.subscriptionAlive, false);
    assert.match(h.reasons.join(), /subscription is gone/);
  });

  it("flags a file stuck in Processing Required, and a push Ocrolus stopped retrying after 12 hours", async () => {
    const w = world();
    await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc("lease"), "lease.pdf");
    const times = [0];
    while (true) {
      const r = w.ocrolus.classify(w.enc, LOAN, times.at(-1)!, true);
      if (r === "stopped") break;
      times.push(times.at(-1)! + 300);
    }
    const h = await reconcileLoan(w.deps(13 * 3600), LOAN);
    assert.equal(h.lockStalled, true);
    assert.deepEqual(h.stuck, [w.enc.loan(LOAN).attachments[0]!.title]);
    assert.equal(h.health, "red");
  });

  it("finds the Book by loan GUID, though two Books share a name", async () => {
    const w = world();
    assert.equal(w.ocrolus.books.filter((b) => b.name === "Sample SYN-0202").length, 2);
    assert.equal((await reconcileLoan(w.deps(0), "loan-synthetic-0303")).book, "book-synthetic-0303");
    assert.throws(() => w.ocrolus.bookFromLoan({ loan_id: LOAN, loan_number: "SYN-0202" }), /exactly one/);
  });

  it("reports the day's container counts across loans", async () => {
    const w = world();
    await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc(`scan ${UNSUPPORTED_MARK}`), "scan.pdf");
    await attachOnce({ api: w.enc, ledger: w.ledger, by: "connector" }, LOAN, doc("note"), "note.pdf");
    w.ocrolus.classify(w.enc, LOAN, 0, false);
    const counts = dailyCounts("2026-11-01", [await reconcileLoan(w.deps(10), LOAN)]);
    assert.deepEqual(counts, { day: "2026-11-01", loans: 1, red: 0, containers: { [CONTAINER.complete]: 2, [CONTAINER.unknown]: 1 }, unknownPages: 1, duplicates: 0 });
  });
});

describe(`Ocrolus's push retries while a person has the loan open [doc: ${OCROLUS_DOC}/docs/encompass-classify, checked 2026-11-01]`, () => {
  it("tries every 5 minutes for an hour, every 15 until 6 hours, hourly until 12, then stops", () => {
    assert.equal(nextPushTry(0, 0), 300);
    assert.equal(nextPushTry(0, 3300), 3600);
    assert.equal(nextPushTry(0, 3600), 3600 + 900);
    assert.equal(nextPushTry(0, 6 * 3600), 7 * 3600);
    assert.equal(nextPushTry(0, 11 * 3600), 12 * 3600);
    assert.equal(nextPushTry(0, 12 * 3600), "STOP");
  });
});

describe(`webhook intake [docs: ${OCROLUS_DOC}/docs/secure-webhook-urls, https://docs.partnerconnect.elliemae.com/partnerconnect/docs/webhooks, checked 2026-11-01]`, () => {
  it("verifies Ocrolus's HMAC over timestamp.request_id.body and refuses a stale or forged one", () => {
    const body = '{"event_name":"book.completed"}';
    const headers = { "Webhook-Signature": signOcrolus("synthetic-secret-0123", "1793500000", "req-1", body), "Webhook-Timestamp": "1793500000", "Webhook-Request-Id": "req-1" };
    assert.equal(verifyOcrolus("synthetic-secret-0123", headers, body, 1793500010), true);
    assert.equal(verifyOcrolus("synthetic-secret-0123", headers, `${body} `, 1793500010), false);
    assert.equal(verifyOcrolus("synthetic-secret-0123", headers, body, 1793509999), false);
  });

  it("verifies Elli-Signature as a base64 HMAC-SHA256 of the body", () => {
    const body = '{"eventType":"attachment"}';
    assert.equal(verifyElli(KEY, { "elli-signature": createHmac("sha256", KEY).update(body).digest("base64") }, body), true);
    assert.equal(verifyElli(KEY, { "Elli-Signature": "forged" }, body), false);
  });

  it("answers 2xx only after the durable enqueue, dedupes, and answers 503, never 4xx, when storage fails", () => {
    const ledger = new Ledger(join(dir, "intake.db"));
    assert.deepEqual(intake(ledger, "ocrolus", true, "req-1", "{}"), { status: 200, duplicate: false });
    assert.deepEqual(intake(ledger, "ocrolus", true, "req-1", "{}"), { status: 200, duplicate: true });
    assert.equal(ledger.inbox("ocrolus").length, 1);
    assert.deepEqual(intake({ enqueue: () => { throw new Error("disk full"); } }, "encompass", true, "evt-1", "{}"), { status: 503 });
    assert.deepEqual(intake(ledger, "encompass", false, "evt-2", "{}"), { status: 401 });
  });

  it(`[${DOC}/reference/wbhks-retry-logic] shows why: a 4xx from the handler is never retried, so the event is lost`, () => {
    const enc = new MockEncompass();
    enc.subscribe({ endpoint: "https://connector.example.invalid/hooks", resource: "Loan", events: ["attachment"], signingkey: KEY }, () => 400);
    const e = enc.emit(LOAN, "attachment", "x");
    assert.equal(enc.deliveries.filter((d) => d.eventId === e.eventId).length, 1);
    const exp = new MockEncompass();
    exp.subscribe({ endpoint: "https://connector.example.invalid/hooks", resource: "Loan", events: ["attachment"], deliveryPolicy: { backoff: "exponential" }, signingkey: KEY }, () => 503);
    const e2 = exp.emit(LOAN, "attachment", "x");
    assert.equal(exp.deliveries.filter((d) => d.eventId === e2.eventId).at(-1)!.atSeconds, 8 * 3600);
  });
});
