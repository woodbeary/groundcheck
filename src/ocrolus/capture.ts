/**
 * The Ocrolus Capture adapter for dscr-check. It reads a Book's form data (GET /v1/book/forms;
 * shape from https://docs.ocrolus.com/reference/book-form-data) and maps the documented field keys
 * of six form types to DSCR parts, each through the vendor-field gate:
 *
 * - FORM_1000_OR_1007_SINGLE_FAMILY_COMPARABLE_RENT_SCHEDULE: market rent (Part05 "I (We) Estimate
 *   the Monthly Market Rent of the Subject to Be"), dated by its report signed date;
 * - LEASE_AGREEMENT: monthlyPaymentAmount, leaseStartDate, leaseEndDate;
 * - MORTGAGE_NOTE: principal, interest rate, monthly payment, first payment and maturity dates;
 * - TAX_BILL: totalTaxesDue, its installments, and the issue date;
 * - HOMEOWNER_INSURANCE_POLICY: totalPremium, effectiveDate, expirationDate;
 * - HOMEOWNERS_ASSOCIATION_STATEMENT: assessment amount, frequency and due date.
 *
 * Every key below is copied from Ocrolus's published field tables (checked 2026-11-01). Three
 * mappings are this repository's decisions, to confirm with a lender: the rent schedule's report
 * signed date stands in for its effective date; a tax bill counts as current when issued within
 * the policy's age limit, since TAX_BILL has no fiscal-period field; and totalTaxesDue is read as
 * the annual tax only when its installments add up to it. Anything missing, empty, garbled or
 * below the confidence floor leaves its part as wide as a missing document would.
 */

import { daysBetween } from "../core/dates.ts";
import { dollars } from "../core/format.ts";
import { UNBACKED, atLeast, hull, isPoint, lesser, point, ratio, sum, type Interval, type Tri } from "../core/interval.ts";
import { checkVendor, readVendor, type VendorChecked, type VendorClaim, type VendorField, type VendorKind } from "../core/vendor.ts";
import { amortizedPayment } from "../dscr/check.ts";
import type { Component, DscrPolicy, DscrRequest, Overlay, Part } from "../dscr/types.ts";

export const FORM = {
  rentSchedule: "FORM_1000_OR_1007_SINGLE_FAMILY_COMPARABLE_RENT_SCHEDULE",
  lease: "LEASE_AGREEMENT",
  note: "MORTGAGE_NOTE",
  taxBill: "TAX_BILL",
  insurance: "HOMEOWNER_INSURANCE_POLICY",
  hoa: "HOMEOWNERS_ASSOCIATION_STATEMENT",
} as const;

export const KEY = {
  marketRent: "form_1000_or_1007_single_family_comparable_rent_schedule-Part05-FinalReconciliationOfMarketRent:iWeEstimateTheMonthlyMarketRentOfTheSubjectToBe",
  rentScheduleSigned: "form_1000_or_1007_single_family_comparable_rent_schedule-Part05-FinalReconciliationOfMarketRent:reportSignedDate",
  leaseRent: "lease_agreement-Part1-TenantInfo:monthlyPaymentAmount",
  leaseStart: "lease_agreement-Part1-TenantInfo:leaseStartDate",
  leaseEnd: "lease_agreement-Part1-TenantInfo:leaseEndDate",
  notePrincipal: "mortgage_note-Part2-AmountsAndDate:principalBalanceAmount",
  noteRate: "mortgage_note-Part2-AmountsAndDate:interestRate",
  notePayment: "mortgage_note-Part2-AmountsAndDate:monthlyPaymentAmount",
  noteFirstPayment: "mortgage_note-Part2-AmountsAndDate:firstPaymentDate",
  noteMaturity: "mortgage_note-Part2-AmountsAndDate:maturityDate",
  taxTotal: "tax_bill-PartI-General:totalTaxesDue",
  taxIssued: "tax_bill-PartIv-OtherInformation:issueDate",
  taxInstallments: [1, 2, 3, 4].map((i) => `tax_bill-PartIii-PaymentInformation:installment${i}Amount`),
  insurancePremium: "homeowner_insurance_policy-Part2-PolicyInformation:totalPremium",
  insuranceFrom: "homeowner_insurance_policy-Part2-PolicyInformation:effectiveDate",
  insuranceTo: "homeowner_insurance_policy-Part2-PolicyInformation:expirationDate",
  hoaAmount: "homeowners_association_statement-General:assessmentAmount(HoaDues)",
  hoaFrequency: "homeowners_association_statement-General:assessmentFrequency",
  hoaDue: "homeowners_association_statement-General:dueDate",
} as const;

export interface CaptureForm {
  readonly pk?: number;
  readonly uuid: string;
  readonly uploaded_doc_pk?: number;
  readonly form_type: string;
  readonly raw_fields: Readonly<Record<string, VendorField>>;
}

/** GET /v1/book/forms, as documented. */
export interface BookForms {
  readonly status: number;
  readonly response: { readonly pk?: number; readonly uuid: string; readonly name?: string; readonly forms: readonly CaptureForm[] };
}

export interface VendorDscrPolicy extends DscrPolicy {
  /** A captured field below this confidence is left for a person. An example setting. */
  readonly vendorConfidenceFloor: number;
  /** TAX_BILL has no fiscal period: a bill issued longer ago than this isn't current. An example setting. */
  readonly maxTaxBillAgeDays: number;
}

export const EXAMPLE_VENDOR_POLICY: VendorDscrPolicy = {
  id: "example-dscr-ocrolus",
  routerFloor: 0.6,
  maxAppraisalAgeDays: 120,
  maxDuesStatementAgeDays: 60,
  vendorConfidenceFloor: 0.9,
  maxTaxBillAgeDays: 365,
};

export interface CaptureReport {
  readonly book: string;
  readonly asOf: string;
  readonly policy: string;
  /** Every value here is vendor-field evidence: weaker than a quoted line, and counted apart. */
  readonly evidence: "vendor-field";
  readonly parts: readonly Part[];
  readonly rent: Interval;
  readonly pitia: Interval;
  readonly dscr: Interval;
  readonly overlays: readonly { readonly overlay: Overlay; readonly status: Tri }[];
  readonly needs: readonly string[];
  readonly claims: readonly VendorChecked<number | string>[];
  /** The form and key each backed part came from, for the staging fields' source. */
  readonly sources: Readonly<Partial<Record<Component, string>>>;
}

const PARSE: Record<VendorKind, (raw: string) => number | string> = {
  money: (raw) => Number(raw.replace(/[^\d.]/g, "")),
  percent: (raw) => Number(raw.replace(/[^\d.]/g, "")),
  date: (raw) => {
    const r = readVendor(raw, "date");
    return "value" in r ? r.value : raw;
  },
  text: (raw) => raw.trim(),
};

class Gate {
  readonly claims: VendorChecked<number | string>[] = [];
  readonly floor: number;
  constructor(floor: number) {
    this.floor = floor;
  }

  /** The gated value of `key` on this form, or null. A key the form doesn't carry is not proposed. */
  read(form: CaptureForm, key: string, kind: VendorKind, formType: string, field: string): number | string | null {
    const f = form.raw_fields[key];
    if (!f) return null;
    const claim: VendorClaim<number | string> = {
      field,
      value: PARSE[kind](f.value),
      source: { vendor: "ocrolus", formType: form.form_type, form: form.uuid, key, sourceFilename: f.source_filename, confidence: f.confidence ?? null, raw: f.is_empty ? "" : f.value },
    };
    const checked = checkVendor(claim, { formTypes: [formType], floor: this.floor, kind });
    this.claims.push(checked);
    return checked.status === "supported" ? checked.value : null;
  }

  money(form: CaptureForm, key: string, formType: string, field: string): number | null {
    return this.read(form, key, "money", formType, field) as number | null;
  }

  date(form: CaptureForm, key: string, formType: string, field: string): string | null {
    return this.read(form, key, "date", formType, field) as string | null;
  }

  /** Whether a key was captured but didn't stand: a garbled or doubtful line, not a missing one. */
  failed(form: CaptureForm, key: string): boolean {
    return this.claims.some((c) => c.source.form === form.uuid && c.source.key === key && c.status !== "supported");
  }
}

function part(name: Component, values: readonly Interval[], because: string, none: string): Part {
  return values.length === 0 ? { name, value: UNBACKED, because: none } : { name, value: values.reduce(hull), because };
}

const covers = (from: string | null, to: string | null, day: string) => from !== null && to !== null && from <= day && day <= to;
const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const PER_MONTH: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, "SEMI-ANNUALLY": 6, ANNUALLY: 12 };

export function dscrFromCapture(book: BookForms, request: DscrRequest, overlays: readonly Overlay[], policy: VendorDscrPolicy = EXAMPLE_VENDOR_POLICY): CaptureReport {
  const g = new Gate(policy.vendorConfidenceFloor);
  const asOf = request.asOf;
  const forms = (type: string) => book.response.forms.filter((f) => f.form_type === type || Object.keys(f.raw_fields).some((k) => k.startsWith(type.toLowerCase())));
  const sources: Partial<Record<Component, string>> = {};
  const source = (name: Component, form: CaptureForm, key: string) => (sources[name] = `Ocrolus Book ${book.response.uuid}, ${form.form_type} ${form.uuid}, ${key}`);

  const schedules = forms(FORM.rentSchedule).map((f) => {
    const signed = g.date(f, KEY.rentScheduleSigned, FORM.rentSchedule, "rent schedule signed");
    const age = signed === null ? null : daysBetween(signed, asOf);
    return { form: f, signed, current: age !== null && age >= 0 && age <= policy.maxAppraisalAgeDays, rent: g.money(f, KEY.marketRent, FORM.rentSchedule, "market rent") };
  });
  const currentSchedules = schedules.filter((s) => s.current && s.rent !== null);
  if (currentSchedules[0]) source("market rent", currentSchedules[0].form, KEY.marketRent);
  const market = part(
    "market rent",
    currentSchedules.length === schedules.filter((s) => s.current).length ? currentSchedules.map((s) => point(s.rent!)) : [],
    `1007 signed ${currentSchedules[0]?.signed ?? ""} (vendor field)`,
    schedules.length === 0 ? "no 1007 rent schedule captured" : `no captured rent schedule signed within ${policy.maxAppraisalAgeDays} days before ${asOf} with a market rent that clears the gate`,
  );

  const leases = forms(FORM.lease).map((f) => ({ form: f, start: g.date(f, KEY.leaseStart, FORM.lease, "lease start"), end: g.date(f, KEY.leaseEnd, FORM.lease, "lease end"), rent: g.money(f, KEY.leaseRent, FORM.lease, "lease rent") }));
  const currentLeases = leases.filter((l) => covers(l.start, l.end, asOf));
  if (currentLeases[0]) source("lease rent", currentLeases[0].form, KEY.leaseRent);
  const lease =
    currentLeases.length > 0 && currentLeases.every((l) => l.rent !== null)
      ? part("lease rent", currentLeases.map((l) => point(l.rent!)), `lease ${currentLeases[0]!.start} to ${currentLeases[0]!.end} (vendor field)`, "")
      : part("lease rent", [], "", leases.length === 0 ? "no lease captured" : currentLeases.length === 0 ? `no captured lease term covers ${asOf}` : "the current lease's rent didn't clear the gate");

  const payments: Interval[] = [];
  const paymentWhy: string[] = [];
  for (const f of forms(FORM.note)) {
    const principal = g.money(f, KEY.notePrincipal, FORM.note, "note principal");
    const rate = g.read(f, KEY.noteRate, "percent", FORM.note, "note rate") as number | null;
    const printed = g.money(f, KEY.notePayment, FORM.note, "note payment");
    const first = g.date(f, KEY.noteFirstPayment, FORM.note, "note first payment");
    const maturity = g.date(f, KEY.noteMaturity, FORM.note, "note maturity");
    const failed = [KEY.notePrincipal, KEY.noteRate, KEY.notePayment, KEY.noteFirstPayment, KEY.noteMaturity].filter((k) => g.failed(f, k));
    const months = first !== null && maturity !== null ? monthIndex(maturity) - monthIndex(first) + 1 : null;
    const computed = principal !== null && rate !== null && months !== null && months > 0 ? amortizedPayment(principal, rate, months) : null;
    if (failed.length > 0) {
      payments.push(UNBACKED);
      paymentWhy.push(`note ${f.uuid}: ${failed.length} captured term(s) didn't clear the gate, so the payment can't be cross-checked`);
    } else if (printed !== null && computed !== null && Math.abs(printed - computed) <= 0.01) {
      payments.push(point(printed));
      paymentWhy.push(`note payment ${dollars(printed)} matches its principal, rate and ${months} months (vendor fields)`);
      source("principal and interest", f, KEY.notePayment);
    } else if (printed !== null && computed !== null) {
      payments.push(UNBACKED);
      paymentWhy.push(`note payment ${dollars(printed)} doesn't match ${dollars(computed)} from its own terms`);
    } else {
      payments.push(UNBACKED);
      paymentWhy.push(`note ${f.uuid} doesn't capture both a payment and the terms to check it`);
    }
  }
  const pi = part("principal and interest", payments, paymentWhy.join("; "), "no mortgage note captured");

  const taxValues: Interval[] = [];
  const taxWhy: string[] = [];
  for (const f of forms(FORM.taxBill)) {
    const total = g.money(f, KEY.taxTotal, FORM.taxBill, "tax total due");
    const issued = g.date(f, KEY.taxIssued, FORM.taxBill, "tax bill issued");
    const installments = KEY.taxInstallments.filter((k) => f.raw_fields[k] && !f.raw_fields[k]!.is_empty && f.raw_fields[k]!.value.trim()).map((k) => g.money(f, k, FORM.taxBill, "tax installment"));
    const age = issued === null ? null : daysBetween(issued, asOf);
    if (total === null || age === null || age < 0 || age > policy.maxTaxBillAgeDays) {
      taxWhy.push(`tax bill ${f.uuid}: ${total === null ? "total taxes due didn't clear the gate" : `not issued within ${policy.maxTaxBillAgeDays} days before ${asOf} (TAX_BILL has no fiscal period)`}`);
      continue;
    }
    if (installments.length > 0 && (installments.includes(null) || Math.abs(installments.reduce<number>((a, b) => a + b!, 0) - total) > 0.01)) {
      taxWhy.push(`tax bill ${f.uuid}: total taxes due ${dollars(total)} isn't the sum of its installments, so it isn't read as the annual tax`);
      continue;
    }
    taxValues.push(point(total / 12));
    taxWhy.push(`tax bill issued ${issued}, ${dollars(total)} a year (vendor field; current means issued within ${policy.maxTaxBillAgeDays} days)`);
    source("taxes", f, KEY.taxTotal);
  }
  const taxes = taxValues.length > 0 ? part("taxes", taxValues, taxWhy.join("; "), "") : part("taxes", [], "", taxWhy.join("; ") || "no tax bill captured");

  const insurance = (() => {
    const read = forms(FORM.insurance).map((f) => ({ form: f, from: g.date(f, KEY.insuranceFrom, FORM.insurance, "policy start"), to: g.date(f, KEY.insuranceTo, FORM.insurance, "policy end"), premium: g.money(f, KEY.insurancePremium, FORM.insurance, "annual premium") }));
    const current = read.filter((r) => covers(r.from, r.to, asOf));
    if (current.length > 0 && current.every((r) => r.premium !== null)) {
      source("insurance", current[0]!.form, KEY.insurancePremium);
      return part("insurance", current.map((r) => point(r.premium! / 12)), `policy ${current[0]!.from} to ${current[0]!.to}, ${dollars(current[0]!.premium!)} a year (vendor field)`, "");
    }
    return part("insurance", [], "", read.length === 0 ? "no homeowner insurance policy captured" : `no captured policy with a premium covers ${asOf}`);
  })();

  const duesValues: Interval[] = [];
  const duesWhy: string[] = [];
  for (const f of forms(FORM.hoa)) {
    const amount = g.money(f, KEY.hoaAmount, FORM.hoa, "association assessment");
    const frequency = g.read(f, KEY.hoaFrequency, "text", FORM.hoa, "assessment frequency") as string | null;
    const due = g.date(f, KEY.hoaDue, FORM.hoa, "assessment due");
    const gap = due === null ? null : daysBetween(due, asOf);
    const months = frequency === null ? undefined : PER_MONTH[frequency];
    if (amount === null || months === undefined || gap === null || Math.abs(gap) > policy.maxDuesStatementAgeDays) {
      duesWhy.push(`association statement ${f.uuid}: ${months === undefined ? `frequency ${frequency ?? "not captured"} can't be made monthly` : "amount or due date didn't clear the gate, or the due date isn't within the policy's window"}`);
      continue;
    }
    duesValues.push(point(Math.round((amount / months) * 100) / 100));
    duesWhy.push(`association assessment ${dollars(amount)} ${frequency!.toLowerCase()} (vendor field)`);
    source("association dues", f, KEY.hoaAmount);
  }
  const dues = duesValues.length > 0 ? part("association dues", duesValues, duesWhy.join("; "), "") : part("association dues", [], "", duesWhy.join("; ") || "no association statement captured, and the 1007 fields mapped here carry no association dues line");

  const parts = [lease, market, pi, taxes, insurance, dues];
  const rent = lesser(lease.value, market.value);
  const pitia = sum([pi.value, taxes.value, insurance.value, dues.value]);
  const dscr = ratio(rent, pitia);
  return {
    book: book.response.uuid,
    asOf,
    policy: policy.id,
    evidence: "vendor-field",
    parts,
    rent,
    pitia,
    dscr,
    overlays: overlays.map((overlay) => ({ overlay, status: atLeast(dscr, overlay.minDscr) })),
    needs: parts.filter((p) => !isPoint(p.value)).map((p) => `${p.name}: ${p.because}`),
    claims: g.claims,
    sources,
  };
}
