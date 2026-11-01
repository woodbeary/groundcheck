/**
 * A second kind of evidence, weaker than a quoted line: a value a vendor extractor captured.
 * Ocrolus Capture's `raw_fields` carry a value, a confidence and the source filename, but no page
 * and no quote (https://docs.ocrolus.com/docs/form-data, checked 2026-11-01), so the citation
 * gate can't check them against a printed line. Pretending otherwise would fake a citation.
 *
 * A vendor field stands only if it came from the form type that carries it, the vendor didn't
 * mark it empty, its confidence clears the policy's floor, and its text parses cleanly as one
 * value; a garbled value is held, as on a page. Every gated vendor value says "vendor-field", so
 * reports can count it apart from quoted values.
 */

import { dateTokens } from "./dates.ts";
import { moneyTokens, percentTokens, type Status } from "./evidence.ts";

/** One Capture field, as `raw_fields` returns it. */
export interface VendorField {
  readonly value: string;
  readonly is_empty?: boolean;
  readonly alias_used?: string | null;
  readonly source_filename: string;
  readonly confidence?: number;
}

export interface VendorSource {
  readonly vendor: "ocrolus";
  readonly formType: string;
  /** The form's uuid in the Book. */
  readonly form: string;
  readonly key: string;
  readonly sourceFilename: string;
  readonly confidence: number | null;
  readonly raw: string;
}

export interface VendorClaim<T> {
  readonly field: string;
  readonly value: T;
  readonly source: VendorSource;
}

export interface VendorChecked<T> extends VendorClaim<T> {
  readonly evidence: "vendor-field";
  readonly status: Status;
  readonly reason?: string;
}

export type VendorKind = "money" | "date" | "percent" | "text";

export interface VendorExpect {
  readonly formTypes: readonly string[];
  readonly floor: number;
  readonly kind: VendorKind;
}

function verdict<T>(claim: VendorClaim<T>, status: Status, reason?: string): VendorChecked<T> {
  return reason === undefined ? { ...claim, evidence: "vendor-field", status } : { ...claim, evidence: "vendor-field", status, reason };
}

/** The value a vendor's raw text reads as, or why it can't be read as one. */
export function readVendor(raw: string, kind: VendorKind): { value: number | string } | { garble: string } {
  const text = raw.trim();
  if (kind === "money") {
    const tokens = moneyTokens(text.startsWith("$") ? text : `$${text}`);
    if (tokens.length !== 1) return { garble: `'${raw}' is not one amount` };
    return tokens[0]!.garble ? { garble: tokens[0]!.garble } : { value: tokens[0]!.value! };
  }
  if (kind === "percent") {
    const tokens = percentTokens(text.endsWith("%") ? text : `${text}%`);
    if (tokens.length !== 1) return { garble: `'${raw}' is not one rate` };
    return tokens[0]!.garble ? { garble: tokens[0]!.garble } : { value: tokens[0]!.value! };
  }
  if (kind === "date") {
    const tokens = dateTokens(text);
    if (tokens.length !== 1 || tokens[0]!.text !== text) return { garble: `'${raw}' is not one date` };
    return tokens[0]!.value === null ? { garble: `'${raw}' is not one real date` } : { value: tokens[0]!.value };
  }
  return text ? { value: text } : { garble: "empty" };
}

export function checkVendor<T extends number | string>(claim: VendorClaim<T>, expect: VendorExpect): VendorChecked<T> {
  const s = claim.source;
  if (!expect.formTypes.includes(s.formType)) return verdict(claim, "unsupported", `captured from a ${s.formType} form, not ${expect.formTypes.join(" or ")}`);
  if (!s.raw.trim()) return verdict(claim, "unsupported", `Ocrolus reports ${s.key} empty`);
  if (s.confidence !== null && s.confidence < expect.floor) return verdict(claim, "unsupported", `confidence ${s.confidence} is below the floor of ${expect.floor}; a person checks it`);
  const read = readVendor(s.raw, expect.kind);
  if ("garble" in read) return verdict(claim, "held", read.garble);
  const same = typeof read.value === "number" && typeof claim.value === "number" ? Math.round(read.value * 100) === Math.round(claim.value * 100) : read.value === claim.value;
  return same ? verdict(claim, "supported") : verdict(claim, "unsupported", `the captured text reads as ${read.value}, not ${claim.value}`);
}
