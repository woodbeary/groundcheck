/**
 * The citation gate. A reader (a model, a vendor extractor, or the reference reader here) only
 * proposes values; each proposal names the document, the page and the exact text that prints it.
 * Code then decides whether the value stands:
 *
 * - supported: the cited text is on that page and prints this value, cleanly.
 * - held: the cited text prints something that can't be read as one value (merged edits, digits
 *   that run together, a footnote mark). It is kept out with the reason, never repaired.
 * - unsupported: the text isn't on the page, or it prints a different value.
 *
 * Only supported values may narrow a fact. Held and unsupported ones leave it as wide as if the
 * page were missing.
 */

import { dateTokens } from "./dates.ts";
import { dollars } from "./format.ts";

export interface Page {
  /** Physical page number in the file. Stable when other pages go missing. */
  readonly n: number;
  readonly text: string;
}

export interface Doc {
  readonly id: string;
  readonly pages: readonly Page[];
}

export interface Cite {
  readonly doc: string;
  readonly page: number;
  readonly span: string;
}

export interface Claim<T> {
  readonly field: string;
  readonly value: T;
  readonly cite: Cite;
}

export type Status = "supported" | "held" | "unsupported";

export interface Checked<T> {
  readonly field: string;
  readonly value: T;
  readonly cite: Cite;
  readonly status: Status;
  readonly reason?: string;
}

/** Every proposed value and what the gate made of it, with the line it quoted: one audit row each. */
export interface GatedClaim {
  readonly field: string;
  readonly doc: string;
  readonly page: number;
  readonly quote: string;
  readonly status: Status;
  readonly value: unknown;
  readonly reason?: string;
}

export function gated(checked: Checked<unknown>): GatedClaim {
  const base = { field: checked.field, doc: checked.cite.doc, page: checked.cite.page, quote: checked.cite.span, status: checked.status, value: checked.value };
  return checked.reason === undefined ? base : { ...base, reason: checked.reason };
}

export function backed<T>(checked: Checked<T> | undefined): T | null {
  return checked?.status === "supported" ? checked.value : null;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function verdict<T>(claim: Claim<T>, status: Status, reason?: string): Checked<T> {
  return reason === undefined ? { ...claim, status } : { ...claim, status, reason };
}

/**
 * Where a value has to come from. Printing the number somewhere isn't enough: the quote must sit
 * in the right document, on the line that labels this field, inside the item it belongs to.
 */
export interface Expect {
  readonly doc?: string;
  readonly page?: number;
  /** The quote must print this label, and sit on one printed line unless `within` or `whole` scopes it. */
  readonly label?: { readonly name: string; readonly pattern: RegExp };
  /** The quote must sit inside this text (an item's printed lines). */
  readonly within?: string;
  /** The quote must be all of this text, so a label is never read from part of an item. */
  readonly whole?: string;
}

function onOneLine(page: Page, span: string): boolean {
  return page.text.split("\n").some((line) => squash(line).includes(span));
}

/** The cited span, if it is printed on the cited page where it is expected; otherwise why not. */
function locate(docs: readonly Doc[], cite: Cite, expect: Expect): { span: string } | { missing: string } {
  if (expect.doc !== undefined && cite.doc !== expect.doc) return { missing: `cites "${cite.doc}", not "${expect.doc}"` };
  if (expect.page !== undefined && cite.page !== expect.page) return { missing: `cites page ${cite.page}, not page ${expect.page}` };
  const doc = docs.find((d) => d.id === cite.doc);
  if (!doc) return { missing: `no document "${cite.doc}" in the file` };
  const page = doc.pages.find((p) => p.n === cite.page);
  if (!page) return { missing: `page ${cite.page} of "${cite.doc}" is not in the file` };
  const span = squash(cite.span);
  if (!span) return { missing: "the citation quotes no text" };
  if (!squash(page.text).includes(span)) return { missing: `the quoted text is not on page ${cite.page}` };
  if (expect.label && !expect.label.pattern.test(span)) return { missing: `the quoted text is not a ${expect.label.name} line` };
  if (expect.whole !== undefined && span !== squash(expect.whole)) return { missing: "the quote is only part of the item; its kind is read from all of it" };
  if (expect.within !== undefined && !squash(expect.within).includes(span)) return { missing: "the quote is not from the item it describes" };
  if (expect.label && expect.within === undefined && expect.whole === undefined && !onOneLine(page, span)) {
    return { missing: `the quote runs past the ${expect.label.name} line` };
  }
  return { span };
}

const WELL_FORMED_MONEY = /^\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?$/;
const WELL_FORMED_PERCENT = /^\d{1,3}(?:\.\d{1,4})?%$/;

export interface Token {
  text: string;
  value: number | null;
  /** Why the token can't be read as one value. */
  garble?: string;
}

function trimTail(token: string): string {
  return token.replace(/[.,;:]+$/, "");
}

function garbleOf(token: string, wellFormed: RegExp): string | undefined {
  if ((token.match(/[$%]/g) ?? []).length > 1) return `two numbers in one token ('${token}')`;
  if (token.includes("*")) return `footnote mark on the value ('${token}')`;
  if (!wellFormed.test(token)) return `digits run together or break their grouping ('${token}')`;
  return undefined;
}

/** Every dollar amount printed in the text. */
export function moneyTokens(text: string): Token[] {
  return [...squash(text).matchAll(/\$\s?\d[\d,.$%*]*/g)].map((m) => {
    const token = trimTail(m[0].replace(/^\$\s/, "$"));
    const garble = garbleOf(token, WELL_FORMED_MONEY);
    return garble ? { text: token, value: null, garble } : { text: token, value: Number(token.slice(1).replaceAll(",", "")) };
  });
}

/** Every percent printed in the text. */
export function percentTokens(text: string): Token[] {
  return [...squash(text).matchAll(/\d[\d.,%*]*%[\d.,%*]*/g)].map((m) => {
    const token = trimTail(m[0]);
    const garble = garbleOf(token, WELL_FORMED_PERCENT);
    return garble ? { text: token, value: null, garble } : { text: token, value: Number(token.slice(0, -1)) };
  });
}

const cents = (x: number) => Math.round(x * 100);

function checkNumber(docs: readonly Doc[], claim: Claim<number>, expect: Expect, tokensOf: (span: string) => Token[], show: (n: number) => string): Checked<number> {
  const located = locate(docs, claim.cite, expect);
  if ("missing" in located) return verdict(claim, "unsupported", located.missing);
  const tokens = tokensOf(located.span);
  const garbled = tokens.find((t) => t.garble);
  if (garbled?.garble) return verdict(claim, "held", garbled.garble);
  if (tokens.some((t) => t.value !== null && cents(t.value) === cents(claim.value))) return verdict(claim, "supported");
  if (tokens.length === 0) return verdict(claim, "unsupported", `the quoted text prints no value; the reader said ${show(claim.value)}`);
  return verdict(claim, "unsupported", `the quoted text prints ${tokens.map((t) => t.text).join(", ")}, not ${show(claim.value)}`);
}

export function checkMoney(docs: readonly Doc[], claim: Claim<number>, expect: Expect = {}): Checked<number> {
  return checkNumber(docs, claim, expect, moneyTokens, dollars);
}

export function checkPercent(docs: readonly Doc[], claim: Claim<number>, expect: Expect = {}): Checked<number> {
  return checkNumber(docs, claim, expect, percentTokens, (n) => `${n}%`);
}

/** A whole count printed after a label, e.g. "360 months". */
export function checkCount(docs: readonly Doc[], claim: Claim<number>, unit: string, expect: Expect = {}): Checked<number> {
  const located = locate(docs, claim.cite, expect);
  if ("missing" in located) return verdict(claim, "unsupported", located.missing);
  const runs = [...located.span.matchAll(new RegExp(`(\\S+)\\s+${unit}\\b`, "gi"))].map((m) => m[1]!);
  const bad = runs.find((run) => !/^\d+$/.test(run));
  if (bad) return verdict(claim, "held", `'${bad} ${unit}' is not one whole number`);
  if (runs.some((run) => Number(run) === claim.value)) return verdict(claim, "supported");
  return verdict(claim, "unsupported", `the quoted text doesn't print ${claim.value} ${unit}`);
}

export function checkDate(docs: readonly Doc[], claim: Claim<string>, expect: Expect = {}): Checked<string> {
  const located = locate(docs, claim.cite, expect);
  if ("missing" in located) return verdict(claim, "unsupported", located.missing);
  const tokens = dateTokens(located.span);
  const unreadable = tokens.find((t) => t.value === null);
  if (unreadable) return verdict(claim, "held", `'${unreadable.text}' is not one real date`);
  if (tokens.some((t) => t.value === claim.value)) return verdict(claim, "supported");
  return verdict(claim, "unsupported", `the quoted text doesn't print ${claim.value}`);
}

/** Free text (an instrument number, a holder's name) must appear in the quote as given. */
export function checkText(docs: readonly Doc[], claim: Claim<string>, expect: Expect = {}): Checked<string> {
  const located = locate(docs, claim.cite, expect);
  if ("missing" in located) return verdict(claim, "unsupported", located.missing);
  if (!claim.value.trim()) return verdict(claim, "unsupported", "empty value");
  return located.span.includes(squash(claim.value)) ? verdict(claim, "supported") : verdict(claim, "unsupported", `the quoted text doesn't print "${claim.value}"`);
}

/**
 * A label (what kind of lien, what kind of page) is decided by code from the quoted text. The
 * reader's label stands only if code reads the same one; a disagreement is unsupported.
 */
export function checkLabel<T extends string>(docs: readonly Doc[], claim: Claim<T>, labelOf: (span: string) => T, expect: Expect = {}): Checked<T> {
  const located = locate(docs, claim.cite, expect);
  if ("missing" in located) return verdict(claim, "unsupported", located.missing);
  const label = labelOf(located.span);
  return label === claim.value ? verdict(claim, "supported") : verdict(claim, "unsupported", `the quoted text reads as ${label}, not ${claim.value}`);
}

/**
 * Printed "Page i of N" footers. A document is whole only when every page carries one, they agree
 * on N, and 1..N are all present. Absence ("no tax lien") can only be read off a whole document.
 */
export function wholeness(doc: Doc): { whole: true } | { whole: false; reason: string } {
  const footers = doc.pages.map((p) => ({ n: p.n, m: /Page\s+(\d+)\s+of\s+(\d+)/i.exec(p.text) }));
  const unmarked = footers.find((f) => !f.m);
  if (unmarked) return { whole: false, reason: `page ${unmarked.n} of "${doc.id}" has no "Page i of N" footer` };
  const totals = new Set(footers.map((f) => Number(f.m![2])));
  if (totals.size !== 1) return { whole: false, reason: `"${doc.id}" footers disagree on its page count` };
  const total = [...totals][0]!;
  const seen = new Set(footers.map((f) => Number(f.m![1])));
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !seen.has(i));
  if (missing.length > 0) return { whole: false, reason: `"${doc.id}" is missing printed page ${missing.join(", ")} of ${total}` };
  return { whole: true };
}
