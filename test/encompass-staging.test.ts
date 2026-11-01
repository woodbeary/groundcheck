import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { OVERLAYS } from "../src/dscr/policy.ts";
import { DOC, MockEncompass, type LoanEvent } from "../src/encompass/mock.ts";
import { STAGED, stage, stagedValues } from "../src/encompass/staging.ts";
import { ReviewForm, premilestoneComplete, stubElli } from "../src/encompass/ssf.ts";
import { fieldWrites, goldenEntries } from "../src/encompass/writtenby.ts";
import { dscrFromCapture, type BookForms } from "../src/ocrolus/capture.ts";

const LOAN = "loan-synthetic-0101";
const CONNECTOR = "api-user-groundcheck (synthetic)";
const PROCESSOR = "processor-synthetic";
/** Synthetic stand-ins for the loan fields a lender's admin would map; not real Encompass field ids. */
const TARGETS = { [STAGED.leaseRent]: "SYN.SUBJECT.LEASE.RENT", [STAGED.marketRent]: "SYN.SUBJECT.MARKET.RENT" };
const book = (JSON.parse(readFileSync(new URL("../fixtures/ocrolus/book-forms-dscr.json", import.meta.url), "utf8")) as { response: BookForms }).response;
const report = dscrFromCapture(book, { asOf: "2026-10-31" }, OVERLAYS);

function withEvents(enc: MockEncompass): LoanEvent[] {
  const events: LoanEvent[] = [];
  enc.subscribe({ endpoint: "https://connector.example.invalid/hooks/encompass", resource: "Loan", events: ["enhancedfieldchange"], deliveryPolicy: { backoff: "exponential" }, signingkey: "x" }, (e) => {
    events.push(e);
    return 200;
  });
  return events;
}

describe(`staging fields, never a processor's [doc: ${DOC}/docs/loan-locks-bp, checked 2026-11-01]`, () => {
  it("shows why: under a shared lock a guarded direct write still loses a processor's concurrent edit (the last update wins)", async () => {
    const enc = new MockEncompass();
    const before = await enc.getFields(LOAN, ["SYN.SUBJECT.LEASE.RENT"]);
    assert.equal(before["SYN.SUBJECT.LEASE.RENT"], "", "the guard reads the field empty");
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3850.00" }, CONNECTOR);
    assert.equal((await enc.getFields(LOAN, ["SYN.SUBJECT.LEASE.RENT"]))["SYN.SUBJECT.LEASE.RENT"], "3850.00", "the processor's 3100.00 is gone");
  });

  it("writes only CX.ED.* fields, in one call, and leaves the processor's value alone", async () => {
    const enc = new MockEncompass();
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    const calls = enc.calls["setFields"] ?? 0;
    await stage(enc, LOAN, stagedValues(report), CONNECTOR);
    assert.equal(enc.calls["setFields"], calls + 1);
    const fields = await enc.getFields(LOAN, [STAGED.leaseRent, STAGED.dscr, STAGED.status, "SYN.SUBJECT.LEASE.RENT"]);
    assert.deepEqual(fields, { [STAGED.leaseRent]: "3850.00", [STAGED.dscr]: "1.207", [STAGED.status]: "Staged", "SYN.SUBJECT.LEASE.RENT": "3100.00" });
    await assert.rejects(stage(enc, LOAN, { ...stagedValues(report), "SYN.SUBJECT.LEASE.RENT": "3850.00" }, CONNECTOR), /writes only CX\.ED\.\* fields; refused SYN\.SUBJECT\.LEASE\.RENT/);
    assert.equal((await enc.getFields(LOAN, ["SYN.SUBJECT.LEASE.RENT"]))["SYN.SUBJECT.LEASE.RENT"], "3100.00");
  });

  it("stages a part that isn't pinned down as blank, and says what it needs", () => {
    const noLease = dscrFromCapture({ ...book, response: { ...book.response, forms: book.response.forms.filter((f) => f.form_type !== "LEASE_AGREEMENT") } }, { asOf: "2026-10-31" }, OVERLAYS);
    const v = stagedValues(noLease);
    assert.equal(v[STAGED.leaseRent], "");
    assert.equal(v[STAGED.dscr], "0.000 to 1.222");
    assert.match(v[STAGED.needs]!, /lease rent: no lease captured/);
  });
});

describe(`the processor decides in the SSF form [doc: ${DOC}/docs/ellie-mae-scripting-objects-reference, checked 2026-11-01]`, () => {
  it("shows the staged value beside the current one with its source, and Accept commits it under the processor's identity", async () => {
    const enc = new MockEncompass();
    const events = withEvents(enc);
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    await stage(enc, LOAN, stagedValues(report), CONNECTOR);
    const elli = stubElli(enc, LOAN, PROCESSOR);
    const form = new ReviewForm(elli, TARGETS);
    const lease = (await form.rows()).find((r) => r.staged === STAGED.leaseRent)!;
    assert.deepEqual([lease.stagedValue, lease.currentValue, lease.differs], ["3850.00", "3100.00", true]);
    assert.match(lease.source, /LEASE_AGREEMENT f-lease-0001/);
    await form.accept(STAGED.leaseRent);
    assert.equal(elli.commits, 1);
    const writes = events.flatMap(fieldWrites).filter((w) => w.field === "SYN.SUBJECT.LEASE.RENT");
    assert.deepEqual(writes.at(-1), { ...writes.at(-1)!, previousValue: "3100.00", newValue: "3850.00", writtenBy: PROCESSOR });
  });

  it("logs a processor's own value that differs from the staged one as writtenBy, and adds it to the golden set", async () => {
    const enc = new MockEncompass();
    const events = withEvents(enc);
    await stage(enc, LOAN, stagedValues(report), CONNECTOR);
    const staged = { "SYN.SUBJECT.LEASE.RENT": { value: "3850.00", source: stagedValues(report)[STAGED.source]! } };
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    const golden = goldenEntries(events.flatMap(fieldWrites), staged, CONNECTOR);
    assert.equal(golden.length, 1);
    assert.deepEqual([golden[0]!.staged, golden[0]!.processorValue, golden[0]!.writtenBy], ["3850.00", "3100.00", PROCESSOR]);
    assert.equal(goldenEntries(events.flatMap(fieldWrites).filter((w) => w.writtenBy === CONNECTOR), staged, CONNECTOR).length, 0);
  });

  it("Keep changes only the review status, so the processor's value stands", async () => {
    const enc = new MockEncompass();
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    await stage(enc, LOAN, stagedValues(report), CONNECTOR);
    await new ReviewForm(stubElli(enc, LOAN, PROCESSOR), TARGETS).keep();
    assert.deepEqual(await enc.getFields(LOAN, ["SYN.SUBJECT.LEASE.RENT", STAGED.status]), { "SYN.SUBJECT.LEASE.RENT": "3100.00", [STAGED.status]: "Reviewed" });
  });

  it("checks premilestoneComplete from local state only, well inside the 1-second web limit", () => {
    const start = performance.now();
    assert.deepEqual(premilestoneComplete({ status: "Staged" }).allow, false);
    assert.deepEqual(premilestoneComplete({ status: "Reviewed" }), { allow: true });
    assert.ok(performance.now() - start < 50);
    assert.equal(premilestoneComplete.length, 1, "it takes the form's state, not a client");
  });
});
