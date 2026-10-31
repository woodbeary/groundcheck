import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateTokens, dayNumber, monthsBefore } from "../src/core/dates.ts";
import { checkCount, checkDate, checkLabel, checkMoney, checkPercent, checkText, moneyTokens, wholeness, type Doc } from "../src/core/evidence.ts";
import { UNBACKED, all, atLeast, atMost, inside, lesser, percentOf, point, ratio } from "../src/core/interval.ts";

const docs: Doc[] = [
  {
    id: "d",
    pages: [
      { n: 1, text: "Line amount: $375400,000\nMax CLTV: 75%85%***\nRate: 7.125%\nSigned March 3, 20212022\nPage 1 of 2" },
      { n: 2, text: "Monthly Rent: $2,450.00\nTerm: 360 months\nTerm: 36O months\nRecorded March 3, 2021\nPage 2 of 2" },
    ],
  },
];
const cite = (page: number, span: string) => ({ doc: "d", page, span });

describe("interval", () => {
  it("passes only when every value holds, fails only when none does", () => {
    assert.equal(inside({ lo: 60, hi: 70 }, 0, 80), "pass");
    assert.equal(inside({ lo: 85, hi: 90 }, 0, 80), "fail");
    assert.equal(inside({ lo: 75, hi: 85 }, 0, 80), "unknown");
    assert.equal(atMost(UNBACKED, 80), "unknown");
    assert.equal(atLeast(point(1.25), 1.25), "pass");
  });

  it("divides ranges without inventing a bound", () => {
    assert.deepEqual(ratio(point(3000), point(2000)), point(1.5));
    assert.deepEqual(ratio({ lo: 0, hi: 3000 }, point(2000)), { lo: 0, hi: 1.5 });
    assert.deepEqual(ratio(point(3000), { lo: 2000, hi: Infinity }), { lo: 0, hi: 1.5 });
    assert.deepEqual(ratio(point(3000), { lo: 0, hi: 2000 }), { lo: 1.5, hi: Infinity });
    assert.deepEqual(ratio(point(1), point(0)), UNBACKED);
    assert.deepEqual(percentOf(point(560_000), point(700_000)), point(80));
  });

  it("takes the lesser of two amounts value by value", () => {
    assert.deepEqual(lesser(point(2450), UNBACKED), { lo: 0, hi: 2450 });
    assert.deepEqual(lesser(point(2450), point(2600)), point(2450));
  });

  it("is unknown when anything is unknown and fails when anything fails", () => {
    assert.equal(all(["pass", "pass"]), "pass");
    assert.equal(all(["pass", "unknown"]), "unknown");
    assert.equal(all(["unknown", "fail"]), "fail");
  });
});

describe("dates", () => {
  it("rejects days that don't exist", () => {
    assert.equal(dayNumber("2026-02-29"), null);
    assert.equal(dayNumber("2026-13-01"), null);
    assert.notEqual(dayNumber("2028-02-29"), null);
  });

  it("counts seasoning in calendar months", () => {
    assert.equal(monthsBefore("2026-10-31", 12), "2025-10-31");
    assert.equal(monthsBefore("2028-02-29", 12), "2027-02-28");
    assert.equal(monthsBefore("2026-03-31", 1), "2026-02-28");
  });

  it("reads printed dates strictly and marks merged ones unreadable", () => {
    assert.deepEqual(dateTokens("recorded March 3, 2021 and 07/18/2023"), [
      { text: "March 3, 2021", value: "2021-03-03" },
      { text: "07/18/2023", value: "2023-07-18" },
    ]);
    assert.equal(dateTokens("March 3, 20212022")[0]?.value, null);
  });
});

describe("citation gate", () => {
  it("supports a value the cited text prints cleanly", () => {
    assert.equal(checkMoney(docs, { field: "rent", value: 2450, cite: cite(2, "Monthly Rent: $2,450.00") }).status, "supported");
    assert.equal(checkPercent(docs, { field: "rate", value: 7.125, cite: cite(1, "Rate: 7.125%") }).status, "supported");
    assert.equal(checkDate(docs, { field: "rec", value: "2021-03-03", cite: cite(2, "Recorded March 3, 2021") }).status, "supported");
    assert.equal(checkCount(docs, { field: "term", value: 360, cite: cite(2, "Term: 360 months") }, "months").status, "supported");
  });

  it("holds merged digits instead of repairing them", () => {
    const repaired = checkMoney(docs, { field: "line", value: 400_000, cite: cite(1, "Line amount: $375400,000") });
    assert.equal(repaired.status, "held");
    assert.match(repaired.reason ?? "", /\$375400,000/);
    const literal = checkMoney(docs, { field: "line", value: 375_400_000, cite: cite(1, "Line amount: $375400,000") });
    assert.equal(literal.status, "held");
  });

  it("holds two numbers in one token and a dangling footnote mark", () => {
    const cltv = checkPercent(docs, { field: "cltv", value: 85, cite: cite(1, "Max CLTV: 75%85%***") });
    assert.equal(cltv.status, "held");
    assert.match(cltv.reason ?? "", /two numbers in one token/);
    assert.deepEqual(moneyTokens("$1,500.00*").map((t) => t.garble !== undefined), [true]);
  });

  it("holds a date or a count that can't be read as one value", () => {
    assert.equal(checkDate(docs, { field: "signed", value: "2021-03-03", cite: cite(1, "Signed March 3, 20212022") }).status, "held");
    assert.equal(checkCount(docs, { field: "term", value: 360, cite: cite(2, "Term: 36O months") }, "months").status, "held");
  });

  it("rejects text that isn't on the cited page, and values the text doesn't print", () => {
    assert.equal(checkMoney(docs, { field: "rent", value: 2450, cite: cite(1, "Monthly Rent: $2,450.00") }).status, "unsupported");
    assert.equal(checkMoney(docs, { field: "rent", value: 2500, cite: cite(2, "Monthly Rent: $2,450.00") }).status, "unsupported");
    assert.equal(checkMoney(docs, { field: "rent", value: 2450, cite: { doc: "x", page: 2, span: "Monthly Rent" } }).status, "unsupported");
    assert.equal(checkText(docs, { field: "who", value: "Pat Sample", cite: cite(2, "Monthly Rent") }).status, "unsupported");
  });

  it("rejects a printed value quoted from the wrong document, page or line", () => {
    const rent = { field: "rent", value: 2450, cite: cite(2, "Monthly Rent: $2,450.00") };
    const label = { name: "market rent", pattern: /market rent/i };
    assert.equal(checkMoney(docs, rent, { label }).status, "unsupported");
    assert.equal(checkMoney(docs, rent, { doc: "lease" }).status, "unsupported");
    assert.equal(checkMoney(docs, rent, { page: 1 }).status, "unsupported");
    assert.equal(checkMoney(docs, rent, { within: "Term: 360 months" }).status, "unsupported");
    assert.equal(checkMoney(docs, rent, { doc: "d", page: 2, label: { name: "monthly rent", pattern: /monthly rent/i } }).status, "supported");
  });

  it("lets code, not the reader, decide a label", () => {
    const labelOf = (span: string) => (span.includes("Rent") ? "rent" : "other");
    assert.equal(checkLabel(docs, { field: "k", value: "rent", cite: cite(2, "Monthly Rent") }, labelOf).status, "supported");
    assert.equal(checkLabel(docs, { field: "k", value: "other", cite: cite(2, "Monthly Rent") }, labelOf).status, "unsupported");
  });

  it("calls a document whole only when every printed page is there", () => {
    assert.deepEqual(wholeness(docs[0]!), { whole: true });
    const missing = wholeness({ id: "d", pages: [docs[0]!.pages[0]!] });
    assert.equal(missing.whole, false);
    assert.equal(wholeness({ id: "d", pages: [{ n: 1, text: "no footer" }] }).whole, false);
  });
});
