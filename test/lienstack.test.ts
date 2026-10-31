import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { point } from "../src/core/interval.ts";
import { kindOf, lienstack, readTitle, type LienReport, type LienRequest, type RuleId, type TitleReader } from "../src/lienstack/index.ts";
import { edit, example, withRequest } from "./helpers.ts";

const title = (id: string) => example<LienRequest>("title", id);
const status = (r: LienReport, id: RuleId) => r.checks.find((c) => c.id === id)?.status;

describe("kindOf", () => {
  it("tells recorded liens from the items that only look like them", () => {
    assert.equal(kindOf("1. Property taxes for the fiscal year 2026-2027, a lien not yet due or payable."), "property-taxes");
    assert.equal(kindOf("4. A Notice of Federal Tax Lien for $9,877.00"), "tax-lien");
    assert.equal(kindOf("5. An Abstract of Judgment for $18,240.00"), "judgment");
    assert.equal(kindOf("A Deed of Trust (Line of Credit) to secure an indebtedness"), "credit-line-deed-of-trust");
    assert.equal(kindOf("A Deed of Trust (Home Equity Conversion Mortgage) to secure"), "reverse-mortgage");
    assert.equal(kindOf("A Subordination Agreement wherein the Deed of Trust recorded as Instrument No. 1"), "subordination");
    assert.equal(kindOf("A Deed of Trust to secure an indebtedness in the amount of $412,000.00"), "deed-of-trust");
    assert.equal(kindOf("2. Easement for public utilities, recorded June 2, 1987"), "other");
  });
});

describe("lienstack on the synthetic files", () => {
  it("passes a whole, fresh report with one seasoned first lien and a current statement", () => {
    const r = lienstack(title("title-01"));
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.cltv, point((371_218.4 + 100_000) / 7_000));
    assert.deepEqual(r.heloc, { balance: point(371_218.4), otherLoan: "no", otherBalance: point(0) });
    assert.equal(r.problems.length, 0);
  });

  it("finds the second lien the borrower may not mention, and answers the engine's question with it", () => {
    const r = lienstack(title("title-02"));
    assert.equal(status(r, "second-position"), "fail");
    assert.equal(status(r, "no-senior-heloc"), "fail");
    assert.equal(r.verdict, "fail");
    assert.equal(r.heloc.otherLoan, "yes");
    assert.deepEqual(r.heloc.otherBalance, point(41_300));
  });

  it("lets a payoff at closing clear position, as a condition, without lowering CLTV", () => {
    const before = lienstack(title("title-02"));
    const r = lienstack(withRequest(title("title-02"), { payoff: ["2023-0456789"] }));
    assert.equal(status(r, "second-position"), "pass");
    assert.equal(status(r, "no-senior-heloc"), "pass");
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.cltv, before.cltv);
    assert.match(r.conditions[0] ?? "", /2023-0456789/);
  });

  it("holds a merged-digit recorded amount, so no statement narrows that lien", () => {
    const r = lienstack(title("title-03"));
    assert.equal(r.problems[0]?.status, "held");
    assert.equal(status(r, "cltv"), "unknown");
    assert.equal(r.cltv.hi, Infinity);
    assert.equal(r.verdict, "unknown");
  });

  it("refuses a reader that repairs the merged digits and ties the wrong statement", () => {
    const repairing: TitleReader = (docs) => {
      const reading = readTitle(docs);
      return {
        ...reading,
        reports: reading.reports.map((rep) => ({
          ...rep,
          items: rep.items.map((item) => (item.amount ? { ...item, amount: { ...item.amount, value: 400_000 } } : item)),
        })),
      };
    };
    const r = lienstack(title("title-03"), repairing);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.problems.find((p) => p.field === "item 3 amount")?.status, "held");
  });

  it("can't rule anything out when a printed page is missing", () => {
    const r = lienstack(title("title-04"));
    for (const c of r.checks) assert.equal(c.status, "unknown", c.id);
    assert.equal(r.heloc.otherLoan, "unknown");
    assert.equal(r.heloc.otherBalance.hi, Infinity);
  });

  it("fails a recorded tax lien and judgment, but not the coming year's property taxes", () => {
    const r = lienstack(title("title-05"));
    assert.equal(status(r, "no-tax-or-judgment"), "fail");
    const clean = lienstack(title("title-01"));
    assert.equal(status(clean, "no-tax-or-judgment"), "pass");
  });

  it("counts only the newest report and names the one it superseded", () => {
    const r = lienstack(title("title-06"));
    assert.equal(r.report.current, "prelim-october");
    assert.deepEqual(r.report.superseded, ["prelim-september"]);
    assert.equal(r.verdict, "pass");
    assert.equal(r.liens.some((l) => l.instrument === "2016-0110042"), false);
  });
});

describe("lienstack judges dates on the request day", () => {
  it("won't rely on a report older than the policy allows", () => {
    const r = lienstack(withRequest(title("title-01"), { asOf: "2027-01-15" }));
    assert.equal(status(r, "title"), "unknown");
    assert.equal(r.verdict, "unknown");
    assert.match(r.checks[0]!.because, /98 days old/);
  });

  it("fails closed on a report dated after the request", () => {
    const r = lienstack(withRequest(title("title-01"), { asOf: "2026-10-01" }));
    assert.equal(r.verdict, "unknown");
    assert.match(r.checks[0]!.because, /after the request date/);
  });

  it("ignores a statement older than the policy allows", () => {
    const r = lienstack(edit(title("title-01"), "Statement Date: October 15, 2026", "Statement Date: June 15, 2026"));
    assert.equal(status(r, "cltv"), "unknown");
  });

  it("fails a first lien recorded less than 12 months before the request", () => {
    const r = lienstack(edit(title("title-01"), "recorded March 3, 2021", "recorded May 1, 2026"));
    assert.equal(status(r, "first-seasoned"), "fail");
  });
});

describe("lienstack rules on printed text", () => {
  it("fails a reverse mortgage and a senior line of credit", () => {
    const reverse = lienstack(edit(title("title-01"), "A Deed of Trust to secure", "A Deed of Trust (Home Equity Conversion Mortgage) to secure"));
    assert.equal(status(reverse, "no-reverse-mortgage"), "fail");
    const line = lienstack(edit(title("title-01"), "A Deed of Trust to secure", "A Deed of Trust (Line of Credit) to secure"));
    assert.equal(status(line, "no-senior-heloc"), "fail");
  });

  it("won't take recording order on faith when a subordination agreement is recorded", () => {
    const r = lienstack(
      edit(title("title-01"), "4. Covenants", "4. A Subordination Agreement recorded April 2, 2021 as Instrument No. 2021-0140001 affecting the Deed of Trust recorded as Instrument No. 2021-0123456.\n5. Covenants"),
    );
    assert.equal(status(r, "second-position"), "unknown");
    assert.equal(r.verdict, "unknown");
  });

  it("drops a reader's label that the printed text doesn't support, and can't pass without it", () => {
    const mislabels: TitleReader = (docs) => {
      const reading = readTitle(docs);
      return {
        ...reading,
        reports: reading.reports.map((rep) => ({
          ...rep,
          items: rep.items.map((item) => (item.kind.value === "credit-line-deed-of-trust" ? { ...item, kind: { ...item.kind, value: "deed-of-trust" as const } } : item)),
        })),
      };
    };
    const r = lienstack(withRequest(title("title-02"), { payoff: ["2021-0123456"] }), mislabels);
    assert.equal(status(r, "no-senior-heloc"), "unknown");
    assert.notEqual(r.verdict, "pass");
  });

  it("can't pass an absence check when the reader skipped an item", () => {
    const skips: TitleReader = (docs) => {
      const reading = readTitle(docs);
      return { ...reading, reports: reading.reports.map((rep) => ({ ...rep, items: rep.items.filter((item) => item.number !== 4) })) };
    };
    const r = lienstack(title("title-05"), skips);
    assert.notEqual(status(r, "no-tax-or-judgment"), "pass");
    assert.match(r.checks[0]!.because, /item 4 was not read/);
  });

  it("won't let one item borrow another item's recording date", () => {
    const borrows: TitleReader = (docs) => {
      const reading = readTitle(docs);
      return {
        ...reading,
        reports: reading.reports.map((rep) => {
          const easement = rep.items.find((item) => item.number === 2)!;
          return { ...rep, items: rep.items.map((item) => (item.number === 3 ? { ...item, recorded: { ...easement.recorded!, value: "1987-06-02" } } : item)) };
        }),
      };
    };
    const r = lienstack(title("title-01"), borrows);
    assert.equal(r.problems.find((p) => p.field === "item 2 recorded" && p.status === "unsupported")?.reason, "the quote is not from the item it describes");
    assert.equal(status(r, "first-seasoned"), "unknown");
  });

  it("ties a statement to a lien only by its recorded amount, and holds a balance above it", () => {
    const other = lienstack(edit(title("title-01"), "Original Principal: $412,000.00", "Original Principal: $415,000.00"));
    assert.equal(other.cltv.hi, Infinity);
    const above = lienstack(edit(title("title-01"), "Unpaid Principal Balance: $371,218.40", "Unpaid Principal Balance: $418,600.00"));
    assert.equal(above.cltv.hi, Infinity);
    assert.match(above.problems[0]?.reason ?? "", /above the original principal/);
  });

  it("fails CLTV from backed balances alone when they already exceed the limit", () => {
    const r = lienstack(withRequest(title("title-04"), { amount: point(300_000) }));
    assert.equal(status(r, "cltv"), "fail");
  });
});
