import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { point } from "../src/core/interval.ts";
import { amortizedPayment, dscrCheck, keywordRouter, readDscr, type DscrReader, type DscrReport, type DscrRequest, type Router } from "../src/dscr/index.ts";
import { edit, example, withRequest } from "./helpers.ts";

const file = (id: string) => example<DscrRequest>("dscr", id);
const verdicts = (r: DscrReport) => Object.fromEntries(r.overlays.map((o) => [o.overlay.id, o.status]));
const partOf = (r: DscrReport, name: string) => r.parts.find((p) => p.name === name)!;

describe("amortizedPayment", () => {
  it("matches the standard fixed-rate payment", () => {
    assert.equal(Math.round(amortizedPayment(360_000, 7.125, 360) * 100) / 100, 2425.39);
    assert.equal(amortizedPayment(120_000, 0, 360), 333.3333333333333);
  });
});

describe("routing", () => {
  it("sends a blank scan to a person and counts it", () => {
    const r = dscrCheck(file("dscr-04"));
    assert.deepEqual(r.review.map((p) => `${p.doc} p.${p.page}`), ["scan p.7"]);
    assert.equal(r.routed.find((p) => p.doc === "filler")?.cls, "IRRELEVANT");
    assert.equal(r.routed.find((p) => p.doc === "cover")?.cls, "COVER_SHEET");
  });

  it("keeps a page the router is unsure of away from the reader", () => {
    const unsure: Router = (page) => (/LEASE AGREEMENT/.test(page.text) ? { cls: "LEGAL_DOCUMENT", confidence: 0.4 } : keywordRouter(page));
    const r = dscrCheck(file("dscr-01"), { router: unsure });
    assert.equal(r.review.length, 1);
    assert.equal(partOf(r, "lease rent").value.hi, Infinity);
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });

  it("refuses a value read off a page routed elsewhere, whoever read it", () => {
    const wrongClass: Router = (page) => (/LEASE AGREEMENT/.test(page.text) ? { cls: "FINANCIAL_DATA", confidence: 1 } : keywordRouter(page));
    const r = dscrCheck(file("dscr-01"), { router: wrongClass, reader: (docs) => readDscr(docs, docs.flatMap((d) => d.pages.map((p) => ({ doc: d.id, page: p.n, cls: "LEGAL_DOCUMENT" as const, confidence: 1 })))) });
    assert.match(r.problems.find((p) => p.field === "lease rent")?.reason ?? "", /routed FINANCIAL_DATA/);
  });
});

describe("dscr-check on the synthetic files", () => {
  it("passes a complete file on the lesser of lease and market rent over PITIA", () => {
    const r = dscrCheck(file("dscr-01"));
    assert.deepEqual(r.rent, point(3850));
    assert.deepEqual(r.pitia, point(2425.39 + 450 + 130));
    assert.deepEqual(verdicts(r), { "overlay-a": "pass", "overlay-b": "pass" });
    assert.deepEqual(r.needs, []);
  });

  it("never passes a file with no lease", () => {
    const r = dscrCheck(file("dscr-02"));
    assert.deepEqual(r.rent, { lo: 0, hi: 3900 });
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
    assert.match(r.needs[0] ?? "", /lease rent: no lease in the file/);
  });

  it("holds a merged tax total and leaves taxes open", () => {
    const r = dscrCheck(file("dscr-03"));
    assert.equal(r.problems[0]?.status, "held");
    assert.equal(partOf(r, "taxes").value.hi, Infinity);
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });

  it("won't count an insurance policy that ended before the request", () => {
    const r = dscrCheck(file("dscr-04"));
    assert.match(partOf(r, "insurance").because, /covers 2025-03-01 to 2026-03-01, not 2026-10-31/);
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });

  it("applies each overlay's floor to the same range", () => {
    const r = dscrCheck(file("dscr-05"));
    assert.deepEqual(partOf(r, "association dues").value, point(185));
    assert.deepEqual(verdicts(r), { "overlay-a": "fail", "overlay-b": "pass" });
  });

  it("holds a printed payment the note's own terms don't produce", () => {
    const r = dscrCheck(file("dscr-06"));
    assert.match(r.problems[0]?.reason ?? "", /printed \$3,150\.00 doesn't match \$2,425\.39/);
    assert.equal(partOf(r, "principal and interest").value.hi, Infinity);
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });
});

describe("dscr-check judges documents on the request day", () => {
  it("drops a lease that hasn't started or has ended", () => {
    const early = dscrCheck(withRequest(file("dscr-01"), { asOf: "2026-07-15" }));
    assert.equal(partOf(early, "lease rent").value.hi, Infinity);
    const late = dscrCheck(withRequest(file("dscr-01"), { asOf: "2027-08-15" }));
    assert.equal(partOf(late, "lease rent").value.hi, Infinity);
  });

  it("drops a rent schedule older than the policy allows", () => {
    const r = dscrCheck(edit(file("dscr-01"), "Effective Date of Appraisal: September 22, 2026", "Effective Date of Appraisal: March 2, 2026"));
    assert.equal(partOf(r, "market rent").value.hi, Infinity);
    assert.equal(partOf(r, "association dues").value.hi, Infinity);
  });

  it("drops an association statement older than the policy allows", () => {
    const r = dscrCheck(edit(file("dscr-05"), "Statement Date: October 1, 2026", "Statement Date: June 1, 2026"));
    assert.equal(partOf(r, "association dues").value.hi, Infinity);
  });

  it("widens to both values when two current documents disagree", () => {
    const r = dscrCheck(edit(file("dscr-05"), "Association Dues: see association statement", "Association Dues: None"));
    assert.deepEqual(partOf(r, "association dues").value, { lo: 0, hi: 185 });
    assert.ok(r.dscr.lo < r.dscr.hi);
    assert.deepEqual(verdicts(r), { "overlay-a": "fail", "overlay-b": "pass" });
  });
});

describe("dscr-check takes no value on a reader's word", () => {
  it("rejects a reader that fills a missing lease from the market rent line", () => {
    const inventive: DscrReader = (docs, routed) => {
      const reading = readDscr(docs, routed);
      const market = reading.appraisals[0]!.marketRent!;
      return { ...reading, leases: [{ doc: "rent-schedule", rent: { ...market, field: "lease rent" } }] };
    };
    const r = dscrCheck(file("dscr-02"), { reader: inventive });
    assert.equal(r.claims.find((c) => c.field === "lease rent")?.status, "unsupported");
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });

  it("computes the payment from the note when the payment line is missing", () => {
    const r = dscrCheck(edit(file("dscr-01"), "Monthly Principal and Interest Payment: $2,425.39", "Payment schedule: see page 2"));
    assert.deepEqual(partOf(r, "principal and interest").value, point(2425.39));
    assert.match(partOf(r, "principal and interest").because, /computed from note/);
  });
});

describe("dscr-check won't take a printed payment on faith", () => {
  it("leaves the payment open when the note's principal is garbled, instead of accepting the printed payment unchecked", () => {
    const r = dscrCheck(edit(file("dscr-06"), "Principal Amount: $360,000.00", "Principal Amount: $318360,000.00"));
    assert.equal(partOf(r, "principal and interest").value.hi, Infinity);
    assert.match(partOf(r, "principal and interest").because, /prints its principal but the line is not backed/);
    assert.deepEqual(verdicts(r), { "overlay-a": "unknown", "overlay-b": "unknown" });
  });

  it("leaves the payment open when a garbled payment line hides a mismatch, instead of computing around it", () => {
    const r = dscrCheck(edit(file("dscr-06"), "Payment: $3,150.00", "Payment: $3183,150.00"));
    assert.equal(partOf(r, "principal and interest").value.hi, Infinity);
  });
});
