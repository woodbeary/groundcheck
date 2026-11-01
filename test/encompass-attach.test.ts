import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Crash, PROCESSING_REQUIRED, UNCONFIRMED_QUEUE, attachOnce, resubmit, settleOpen, titleTag, type CrashPoint } from "../src/encompass/attach.ts";
import { Ledger } from "../src/encompass/ledger.ts";
import { DOC, HttpError, MockEncompass } from "../src/encompass/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "groundcheck-ledger-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ledgerPath = () => join(dir, `ledger-${(n += 1)}.db`);
const LOAN = "loan-synthetic-0101";
const lease = new TextEncoder().encode("%PDF-1.4 synthetic renewed lease, every word invented");
const sha = createHash("sha256").update(lease).digest("hex");
const copies = (enc: MockEncompass) => enc.loan(LOAN).attachments.filter((a) => a.bytes && createHash("sha256").update(a.bytes).digest("hex") === sha).length;
const crashAt = (point: CrashPoint) => (p: CrashPoint) => {
  if (p === point) throw new Crash(point);
};

describe("the ledger", () => {
  it("is SQLite in WAL mode, built by the SQL migrations, each applied once", () => {
    const path = ledgerPath();
    const a = new Ledger(path);
    assert.equal(a.journalMode(), "wal");
    a.close();
    const b = new Ledger(path);
    assert.deepEqual((b.db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version), ["001_ledger.sql"]);
    b.close();
  });
});

describe(`attaching at most once [doc: ${DOC}/reference/create-attachment-url, checked 2026-11-01]`, () => {
  it("writes the ledger row first, uploads once, reads it back and confirms it", async () => {
    const enc = new MockEncompass();
    const ledger = new Ledger(ledgerPath());
    const r = await attachOnce({ api: enc, ledger, by: "connector" }, LOAN, lease, "lease-renewal.pdf");
    assert.equal(r.state, "confirmed");
    assert.equal(copies(enc), 1);
    assert.equal(enc.loan(LOAN).attachments[0]!.title, titleTag(sha));
    assert.equal(enc.loan(LOAN).attachments[0]!.container, PROCESSING_REQUIRED);
    const again = await attachOnce({ api: enc, ledger, by: "connector" }, LOAN, lease, "lease-renewal.pdf");
    assert.match(again.how, /already confirmed/);
    assert.equal(enc.calls["createAttachmentUploadUrl"], 1);
  });

  for (const point of ["after-url", "after-put", "after-commit"] as const) {
    it(`kill test: the process dies ${point}; on restart the lookup settles it, and nothing is sent twice`, async () => {
      const enc = new MockEncompass({ emptyRecordOnUrl: true });
      const path = ledgerPath();
      const big = point === "after-commit";
      const bytes = big ? new Uint8Array(61 * 1024 * 1024).fill(7) : lease;
      await assert.rejects(attachOnce({ api: enc, ledger: new Ledger(path), by: "connector", crash: crashAt(point) }, LOAN, bytes, "file.pdf"), Crash);
      const restarted = new Ledger(path);
      const settled = await settleOpen({ api: enc, ledger: restarted, by: "connector" });
      assert.equal(settled.length, 1);
      assert.equal(enc.calls["createAttachmentUploadUrl"], 1, "the upload URL is never created twice");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const stored = enc.loan(LOAN).attachments.filter((a) => a.bytes && createHash("sha256").update(a.bytes).digest("hex") === hash).length;
      if (point === "after-url") {
        assert.equal(settled[0]!.state, "unconfirmed_never_resubmitted");
        assert.equal(stored, 0);
        assert.equal(restarted.queued(UNCONFIRMED_QUEUE).length, 1);
      } else {
        assert.equal(settled[0]!.state, "confirmed");
        assert.equal(stored, 1);
      }
      assert.deepEqual(await settleOpen({ api: enc, ledger: restarted, by: "connector" }), []);
    });
  }

  it("closes a 200 that kept nothing as unconfirmed_never_resubmitted, in a named queue, and never PUTs again", async () => {
    const enc = new MockEncompass();
    enc.dropNextPut = true;
    const ledger = new Ledger(ledgerPath());
    const r = await attachOnce({ api: enc, ledger, by: "connector" }, LOAN, lease, "lease-renewal.pdf");
    assert.equal(r.state, "unconfirmed_never_resubmitted");
    assert.equal(enc.calls["upload"], 1);
    assert.match(ledger.queued(UNCONFIRMED_QUEUE)[0]!.reason, /can't be found in the eFolder/);
    const connector = await attachOnce({ api: enc, ledger, by: "connector" }, LOAN, lease, "lease-renewal.pdf");
    assert.match(connector.how, /only a person resubmits/);
    assert.equal(enc.calls["upload"], 1);
    const person = await resubmit({ api: enc, ledger, by: "processor (synthetic)" }, LOAN, lease, "lease-renewal.pdf");
    assert.equal(person.state, "confirmed");
    assert.deepEqual(ledger.forLoan(LOAN).map((row) => [row.attempt, row.requested_by, row.state]), [
      [1, "connector", "unconfirmed_never_resubmitted"],
      [2, "processor (synthetic)", "confirmed"],
    ]);
  });

  it(`[doc: ${DOC}/reference/upload-attachment-to-efolder] finds the file by title tag after conversion replaces its ID`, async () => {
    const enc = new MockEncompass({ documentConversion: true });
    const r = await attachOnce({ api: enc, ledger: new Ledger(ledgerPath()), by: "connector", crash: crashAt("after-put") }, LOAN, lease, "x.pdf").catch((e: unknown) => e);
    assert.ok(r instanceof Crash);
    const [settled] = await settleOpen({ api: enc, ledger: new Ledger(join(dir, `ledger-${n}.db`)), by: "connector" });
    assert.equal(settled!.state, "confirmed");
    assert.match(settled!.how, /title tag/);
    assert.equal(settled!.attachmentId, enc.loan(LOAN).attachments[0]!.id);
  });

  it("[doc: https://docs.ocrolus.com/docs/encompass-classify, checked 2026-11-01] finds the file by its hash after Ocrolus renames it", async () => {
    const enc = new MockEncompass({ documentConversion: true });
    const path = ledgerPath();
    await assert.rejects(attachOnce({ api: enc, ledger: new Ledger(path), by: "connector", crash: crashAt("after-put") }, LOAN, lease, "x.pdf"), Crash);
    enc.loan(LOAN).attachments[0]!.title = "Lease Agreement - Sample";
    const [settled] = await settleOpen({ api: enc, ledger: new Ledger(path), by: "connector" });
    assert.match(settled!.how, /downloading and hashing/);
    assert.equal(copies(enc), 1);
  });

  it("retries reads on 429 and never retries a write", async () => {
    const enc = new MockEncompass();
    const ledger = new Ledger(ledgerPath());
    let failures = 2;
    let puts = 0;
    const flaky = Object.assign(Object.create(enc) as MockEncompass, {
      listAttachments: (loan: string) => (failures-- > 0 ? Promise.reject(new HttpError(429, "Too Many Requests")) : enc.listAttachments(loan)),
      upload: () => {
        puts += 1;
        return Promise.reject(new HttpError(503, "Service Unavailable"));
      },
    });
    const r = await attachOnce({ api: flaky, ledger, by: "connector" }, LOAN, lease, "x.pdf");
    assert.equal(r.state, "unconfirmed_never_resubmitted");
    assert.equal(failures, -1, "the listing was read three times");
    assert.equal(enc.calls["createAttachmentUploadUrl"], 1);
    assert.equal(puts, 1, "the failed PUT is not sent again");
  });
});
