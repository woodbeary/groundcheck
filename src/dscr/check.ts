/**
 * dscr-check: debt service coverage as a range. DSCR here is qualifying monthly rent over monthly
 * PITIA (principal and interest, taxes, insurance, association dues). Qualifying rent is the lesser
 * of the current lease and the appraiser's market rent. Every part is read from a cited, current
 * document or left as wide as it can be, so a missing lease, an expired insurance policy or a
 * garbled tax bill can never pass a file: a floor passes only if it holds for every value the
 * documents allow.
 */

import { daysBetween } from "../core/dates.ts";
import { dollars } from "../core/format.ts";
import {
  backed,
  checkCount,
  checkDate,
  checkLabel,
  checkMoney,
  checkPercent,
  type Checked,
  type Claim,
  type Doc,
  type Expect,
} from "../core/evidence.ts";
import { UNBACKED, ZERO, atLeast, hull, isPoint, lesser, point, ratio, sum, type Interval } from "../core/interval.ts";
import type { Component, DscrPolicy, DscrReading, DscrReport, DscrRequest, DuesLine, GatedClaim, Overlay, PageClass, Part, Problem, Routed } from "./types.ts";

const label = (name: string, pattern: RegExp) => ({ name, pattern });
const L = {
  appraisalDate: label("appraisal effective date", /Effective Date of Appraisal/i),
  marketRent: label("market rent", /Market Rent/i),
  lease: label("monthly rent", /Monthly Rent/i),
  term: label("term", /^Term:/i),
  principal: label("principal amount", /Principal Amount/i),
  rate: label("interest rate", /Interest Rate/i),
  payment: label("principal and interest payment", /Principal and Interest Payment/i),
  fiscalYear: label("fiscal year", /Fiscal Year/i),
  tax: label("total annual tax", /Total Annual Tax/i),
  policyPeriod: label("policy period", /Policy Period/i),
  premium: label("annual premium", /Annual Premium/i),
  duesDate: label("statement date", /Statement Date/i),
  dues: label("monthly assessment", /Monthly Assessment/i),
  noDues: label("association dues", /Association Dues/i),
};

const LEGAL: readonly PageClass[] = ["LEGAL_DOCUMENT"];
const RENT: readonly PageClass[] = ["RENT_SCHEDULE"];
const FINANCIAL: readonly PageClass[] = ["FINANCIAL_DATA"];

const money = dollars;

/** Monthly principal and interest on a fixed-rate, fully amortizing note. */
export function amortizedPayment(principal: number, annualRatePercent: number, months: number): number {
  const r = annualRatePercent / 100 / 12;
  return r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
}

const duesLine = (span: string): DuesLine => (/Association Dues:\s*None\b/i.test(span) ? "none" : "dues");

class Gate {
  readonly problems: Problem[] = [];
  readonly claims: GatedClaim[] = [];
  readonly docs: readonly Doc[];
  readonly routed: readonly Routed[];

  constructor(docs: readonly Doc[], routed: readonly Routed[]) {
    this.docs = docs;
    this.routed = routed;
  }

  /** Gate a claim: only from a page the router sent to the reader, in the class this field lives on. */
  run<T>(claim: Claim<T> | undefined, classes: readonly PageClass[], check: (c: Claim<T>) => Checked<T>): T | null {
    if (!claim) return null;
    const r = this.routed.find((x) => x.doc === claim.cite.doc && x.page === claim.cite.page);
    const result: Checked<T> =
      r && classes.includes(r.cls)
        ? check(claim)
        : { ...claim, status: "unsupported", reason: r ? `page ${r.page} of "${r.doc}" was routed ${r.cls}` : "the cited page is not in the file" };
    this.claims.push({ field: result.field, doc: result.cite.doc, page: result.cite.page, status: result.status, value: result.value });
    if (result.status !== "supported") {
      this.problems.push({ field: result.field, doc: result.cite.doc, page: result.cite.page, status: result.status, reason: result.reason ?? "" });
    }
    return backed(result);
  }

  money(claim: Claim<number> | undefined, doc: string, classes: readonly PageClass[], l: Expect["label"]): number | null {
    return this.run(claim, classes, (c) => checkMoney(this.docs, c, l ? { doc, label: l } : { doc }));
  }

  date(claim: Claim<string> | undefined, doc: string, classes: readonly PageClass[], l: Expect["label"]): string | null {
    return this.run(claim, classes, (c) => checkDate(this.docs, c, l ? { doc, label: l } : { doc }));
  }
}

function part(name: Component, values: readonly Interval[], because: string, none: string): Part {
  return values.length === 0 ? { name, value: UNBACKED, because: none } : { name, value: values.reduce(hull), because };
}

const covers = (from: string | null, to: string | null, day: string) => from !== null && to !== null && from <= day && day <= to;

export function checkDscr(
  docs: readonly Doc[],
  routed: readonly Routed[],
  reading: DscrReading,
  request: DscrRequest,
  policy: DscrPolicy,
  overlays: readonly Overlay[],
  file = "file",
  sha256 = "",
): DscrReport {
  const g = new Gate(docs, routed);
  const asOf = request.asOf;

  const appraisals = reading.appraisals.map((a) => {
    const effective = g.date(a.effective, a.doc, RENT, L.appraisalDate);
    const age = effective === null ? null : daysBetween(effective, asOf);
    return {
      doc: a.doc,
      current: age !== null && age >= 0 && age <= policy.maxAppraisalAgeDays,
      effective,
      rent: g.money(a.marketRent, a.doc, RENT, L.marketRent),
      noDues: g.run(a.noDues, RENT, (c) => checkLabel(docs, c, duesLine, { doc: a.doc, label: L.noDues })),
    };
  });
  const currentAppraisals = appraisals.filter((a) => a.current);
  const newest = currentAppraisals.reduce<string | null>((d, a) => (a.effective! > (d ?? "") ? a.effective : d), null);
  const latest = currentAppraisals.filter((a) => a.effective === newest);
  const marketNone =
    appraisals.length === 0
      ? "no rent schedule in the file"
      : latest.length > 0
        ? "the current rent schedule's market rent is not backed"
        : appraisals
            .map((a) => (a.effective ? `rent schedule "${a.doc}" is effective ${a.effective}, not within ${policy.maxAppraisalAgeDays} days before ${asOf}` : `rent schedule "${a.doc}" effective date is not backed`))
            .join("; ");
  const market =
    latest.length > 0 && latest.every((a) => a.rent !== null)
      ? part("market rent", latest.map((a) => point(a.rent!)), `rent schedule effective ${newest}`, "")
      : part("market rent", [], "", marketNone);

  const leases = reading.leases.map((l) => {
    const start = g.date(l.start, l.doc, LEGAL, L.term);
    const end = g.date(l.end, l.doc, LEGAL, L.term);
    return { doc: l.doc, start, end, rent: g.money(l.rent, l.doc, LEGAL, L.lease) };
  });
  const currentLeases = leases.filter((l) => covers(l.start, l.end, asOf));
  const leaseNone =
    leases.length === 0
      ? "no lease in the file"
      : currentLeases.length === 0
        ? leases.map((l) => (l.start && l.end ? `lease "${l.doc}" runs ${l.start} to ${l.end}, not over ${asOf}` : `lease "${l.doc}" term is not backed`)).join("; ")
        : "the current lease's rent is not backed";
  const lease =
    currentLeases.length > 0 && currentLeases.every((l) => l.rent !== null)
      ? part("lease rent", currentLeases.map((l) => point(l.rent!)), `lease "${currentLeases[0]!.doc}" ${currentLeases[0]!.start} to ${currentLeases[0]!.end}`, "")
      : part("lease rent", [], "", leaseNone);

  const payments: Interval[] = [];
  const paymentWhy: string[] = [];
  for (const n of reading.notes) {
    const principal = g.money(n.principal, n.doc, LEGAL, L.principal);
    const rate = g.run(n.rate, LEGAL, (c) => checkPercent(docs, c, { doc: n.doc, label: L.rate }));
    const months = g.run(n.termMonths, LEGAL, (c) => checkCount(docs, c, "months", { doc: n.doc, label: L.term }));
    const printed = g.money(n.payment, n.doc, LEGAL, L.payment);
    const computed = principal !== null && rate !== null && months !== null && months > 0 ? amortizedPayment(principal, rate, months) : null;
    const unbacked = [
      ["principal", n.principal, principal],
      ["rate", n.rate, rate],
      ["term", n.termMonths, months],
      ["payment", n.payment, printed],
    ].filter(([, proposed, value]) => proposed !== undefined && value === null).map(([name]) => name as string);
    if (unbacked.length > 0) {
      payments.push(UNBACKED);
      paymentWhy.push(`note "${n.doc}" prints its ${unbacked.join(", ")} but the line is not backed, so the payment can't be cross-checked`);
    } else if (printed !== null && computed !== null) {
      if (Math.abs(printed - computed) <= 0.01) {
        payments.push(point(printed));
        paymentWhy.push(`note "${n.doc}" prints ${money(printed)}, matching its principal, rate and term`);
      } else {
        g.problems.push({
          field: n.payment!.field,
          doc: n.doc,
          page: n.payment!.cite.page,
          status: "held",
          reason: `printed ${money(printed)} doesn't match ${money(computed)} from the note's principal, rate and term`,
        });
        paymentWhy.push(`note "${n.doc}" prints a payment its own terms don't produce`);
        payments.push(UNBACKED);
      }
    } else if (printed !== null) {
      payments.push(UNBACKED);
      paymentWhy.push(`note "${n.doc}" prints ${money(printed)} but no principal, rate and term to check it against`);
    } else if (computed !== null) {
      const rounded = Math.round(computed * 100) / 100;
      payments.push(point(rounded));
      paymentWhy.push(`computed from note "${n.doc}" principal, rate and term`);
    } else {
      payments.push(UNBACKED);
      paymentWhy.push(`note "${n.doc}" backs neither a payment nor its terms`);
    }
  }
  const pi = part("principal and interest", payments, paymentWhy.join("; "), "no note in the file");

  const annual = (name: "taxes" | "insurance", bills: DscrReading["taxBills"], period: Expect["label"], amount: Expect["label"], kind: string): Part => {
    const read = bills.map((b) => ({ doc: b.doc, from: g.date(b.from, b.doc, FINANCIAL, period), to: g.date(b.to, b.doc, FINANCIAL, period), annual: g.money(b.annual, b.doc, FINANCIAL, amount) }));
    const current = read.filter((b) => covers(b.from, b.to, asOf));
    if (current.length > 0 && current.every((b) => b.annual !== null)) {
      return part(name, current.map((b) => point(b.annual! / 12)), `${kind} "${current[0]!.doc}" ${money(current[0]!.annual!)} a year, ${current[0]!.from} to ${current[0]!.to}`, "");
    }
    const none =
      read.length === 0
        ? `no ${kind} in the file`
        : current.length > 0
          ? `the current ${kind}'s amount is not backed`
          : read.map((b) => (b.from && b.to ? `${kind} "${b.doc}" covers ${b.from} to ${b.to}, not ${asOf}` : `${kind} "${b.doc}" period is not backed`)).join("; ");
    return part(name, [], "", none);
  };
  const taxes = annual("taxes", reading.taxBills, L.fiscalYear, L.tax, "tax bill");
  const insurance = annual("insurance", reading.insurance, L.policyPeriod, L.premium, "insurance declarations");

  const duesValues: Interval[] = [];
  const duesWhy: string[] = [];
  for (const d of reading.dues) {
    const date = g.date(d.date, d.doc, FINANCIAL, L.duesDate);
    const monthly = g.money(d.monthly, d.doc, FINANCIAL, L.dues);
    const age = date === null ? null : daysBetween(date, asOf);
    if (monthly !== null && age !== null && age >= 0 && age <= policy.maxDuesStatementAgeDays) {
      duesValues.push(point(monthly));
      duesWhy.push(`association statement "${d.doc}" dated ${date}`);
    }
  }
  for (const a of currentAppraisals) {
    if (a.noDues === "none") {
      duesValues.push(ZERO);
      duesWhy.push(`current rent schedule prints "Association Dues: None"`);
    }
  }
  const dues = part("association dues", duesValues, duesWhy.join("; "), `no association statement within ${policy.maxDuesStatementAgeDays} days, and no current rent schedule prints "Association Dues: None"`);

  const parts = [lease, market, pi, taxes, insurance, dues];
  const rent = lesser(lease.value, market.value);
  const pitia = sum([pi.value, taxes.value, insurance.value, dues.value]);
  const dscr = ratio(rent, pitia);
  return {
    file,
    sha256,
    asOf,
    policy: policy.id,
    routed,
    review: routed.filter((r) => r.cls === "UNCERTAIN"),
    parts,
    rent,
    pitia,
    dscr,
    overlays: overlays.map((overlay) => ({ overlay, status: atLeast(dscr, overlay.minDscr) })),
    needs: parts.filter((p) => !isPoint(p.value)).map((p) => `${p.name}: ${p.because}`),
    problems: g.problems,
    claims: g.claims,
  };
}
