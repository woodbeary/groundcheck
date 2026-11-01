import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkVendor, type VendorClaim } from "../src/core/vendor.ts";
import { OVERLAYS } from "../src/dscr/policy.ts";
import { KEY, dscrFromCapture, type BookForms, type CaptureForm, type CaptureReport } from "../src/ocrolus/capture.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/ocrolus/book-forms-dscr.json", import.meta.url), "utf8")) as { response: BookForms };
const book = FIXTURE.response;
const run = (b: BookForms = book, asOf = "2026-10-31") => dscrFromCapture(b, { asOf }, OVERLAYS);
const status = (r: CaptureReport) => Object.fromEntries(r.overlays.map((o) => [o.overlay.id, o.status]));
const partOf = (r: CaptureReport, name: string) => r.parts.find((p) => p.name === name)!;

/** The Book with one captured field changed (or removed with `null`). */
function withField(key: string, change: Partial<{ value: string; confidence: number; is_empty: boolean }> | null, formType?: string): BookForms {
  const forms = book.response.forms.map((f): CaptureForm => {
    if (!(key in f.raw_fields)) return f;
    const fields = { ...f.raw_fields };
    if (change === null) delete fields[key];
    else fields[key] = { ...fields[key]!, ...change };
    return { ...f, ...(formType ? { form_type: formType } : {}), raw_fields: fields };
  });
  return { ...book, response: { ...book.response, forms } };
}

const claim = (raw: string, confidence = 1, formType = "LEASE_AGREEMENT"): VendorClaim<number> => ({
  field: "lease rent",
  value: 3850,
  source: { vendor: "ocrolus", formType, form: "f", key: KEY.leaseRent, sourceFilename: "LEASE AGREEMENT.pdf", confidence, raw },
});
const expect = { formTypes: ["LEASE_AGREEMENT"], floor: 0.9, kind: "money" as const };

describe("vendor-field evidence [doc: https://docs.ocrolus.com/docs/form-data, checked 2026-11-01]", () => {
  it("stands on form type, a clean parse and a confidence floor, and says it is a vendor field", () => {
    const ok = checkVendor(claim("3850.00"), expect);
    assert.equal(ok.status, "supported");
    assert.equal(ok.evidence, "vendor-field");
    assert.match(checkVendor(claim("3850.00", 0.62), expect).reason ?? "", /confidence 0.62 is below the floor of 0.9/);
    const unscored = checkVendor({ ...claim("3850.00"), source: { ...claim("3850.00").source, confidence: null } }, expect);
    assert.equal(unscored.status, "unsupported", "a field with no confidence hasn't cleared the floor");
    assert.match(unscored.reason ?? "", /no confidence/);
    assert.match(checkVendor(claim("3850.00", 1, "FORM_1000_OR_1007_SINGLE_FAMILY_COMPARABLE_RENT_SCHEDULE"), expect).reason ?? "", /captured from a FORM_1000/);
    assert.equal(checkVendor(claim(""), expect).status, "unsupported");
    assert.equal(checkVendor({ ...claim("3850.00"), value: 3900 }, expect).status, "unsupported");
  });

  it("holds a garbled captured value, as on a page, never repairs it", () => {
    for (const raw of ["3850.00$3950.00", "38503,950.00", "3,850.00*"]) assert.equal(checkVendor(claim(raw), expect).status, "held", raw);
    assert.equal(checkVendor({ field: "d", value: "2026-08-01", source: { ...claim("").source, raw: "08/01/20262027" } }, { formTypes: ["LEASE_AGREEMENT"], floor: 0.9, kind: "date" }).status, "held");
  });
});

describe("Ocrolus Capture adapter for dscr-check [doc-derived fixture: https://docs.ocrolus.com/reference/book-form-data and the six form pages, checked 2026-11-01]", () => {
  it("scores DSCR from the documented field keys, every value a vendor field", () => {
    const r = run();
    assert.deepEqual(r.rent, { lo: 3850, hi: 3850 });
    assert.deepEqual(r.pitia, { lo: 3190.39, hi: 3190.39 });
    assert.deepEqual(status(r), { "overlay-a": "fail", "overlay-b": "pass" });
    assert.equal(r.evidence, "vendor-field");
    assert.ok(r.claims.length >= 17 && r.claims.every((c) => c.evidence === "vendor-field" && c.status === "supported"));
    assert.match(r.sources["lease rent"] ?? "", /LEASE_AGREEMENT f-lease-0001, lease_agreement-Part1-TenantInfo:monthlyPaymentAmount/);
  });

  it("[https://docs.ocrolus.com/docs/form-1000-or-1007] reads market rent from Part05's 'I (We) Estimate the Monthly Market Rent' and dates it by the report signed date", () => {
    assert.equal(KEY.marketRent, "form_1000_or_1007_single_family_comparable_rent_schedule-Part05-FinalReconciliationOfMarketRent:iWeEstimateTheMonthlyMarketRentOfTheSubjectToBe");
    const stale = run(withField(KEY.rentScheduleSigned, { value: "03/02/2026" }));
    assert.equal(partOf(stale, "market rent").value.hi, Infinity);
  });

  it("[https://docs.ocrolus.com/docs/lease-agreement] can't pass a file with no lease, a lease below the confidence floor, or one that has ended", () => {
    const unscored: BookForms = {
      ...book,
      response: {
        ...book.response,
        forms: book.response.forms.map((f) => {
          const field = f.raw_fields[KEY.leaseRent];
          return field ? { ...f, raw_fields: { ...f.raw_fields, [KEY.leaseRent]: { value: field.value, source_filename: field.source_filename } } } : f;
        }),
      },
    };
    for (const b of [withField(KEY.leaseRent, null), withField(KEY.leaseRent, { confidence: 0.62 }), unscored, withField(KEY.leaseEnd, { value: "09/30/2026" })]) {
      const r = run(b);
      assert.equal(partOf(r, "lease rent").value.hi, Infinity);
      assert.deepEqual(r.rent, { lo: 0, hi: 3900 });
      assert.equal(status(r)["overlay-b"], "unknown");
    }
  });

  it("[https://docs.ocrolus.com/docs/mortgage-note] leaves P&I open when a captured term is garbled, instead of trusting the payment", () => {
    const r = run(withField(KEY.notePrincipal, { value: "318360000.00$360000.00" }));
    assert.equal(partOf(r, "principal and interest").value.hi, Infinity);
    assert.equal(r.claims.find((c) => c.source.key === KEY.notePrincipal)?.status, "held");
    const mismatch = run(withField(KEY.notePayment, { value: "3150.00" }));
    assert.match(partOf(mismatch, "principal and interest").because, /doesn't match \$2,425.39/);
  });

  it("[https://docs.ocrolus.com/docs/tax-bill] reads totalTaxesDue as the annual tax only when its installments add up to it", () => {
    const r = run(withField("tax_bill-PartIii-PaymentInformation:installment2Amount", { value: "2900.00" }));
    assert.equal(partOf(r, "taxes").value.hi, Infinity);
    assert.match(partOf(r, "taxes").because, /isn't the sum of its installments/);
    const old = run(withField(KEY.taxIssued, { value: "08/01/2025" }));
    assert.match(partOf(old, "taxes").because, /TAX_BILL has no fiscal period/);
  });

  it("[https://docs.ocrolus.com/docs/homeowners-association-statement] turns a quarterly assessment monthly and won't guess an OTHER frequency", () => {
    assert.deepEqual(partOf(run(withField(KEY.hoaFrequency, { value: "QUARTERLY" })), "association dues").value, { lo: 61.67, hi: 61.67 });
    assert.equal(partOf(run(withField(KEY.hoaFrequency, { value: "OTHER" })), "association dues").value.hi, Infinity);
  });

  it("refuses a field filed under the wrong form type", () => {
    const misfiled = run(withField(KEY.leaseRent, {}, "FORM_1000_OR_1007_SINGLE_FAMILY_COMPARABLE_RENT_SCHEDULE"));
    assert.match(misfiled.claims.find((c) => c.source.key === KEY.leaseRent)?.reason ?? "", /captured from a FORM_1000_OR_1007/);
    assert.equal(partOf(misfiled, "lease rent").value.hi, Infinity);
  });
});
