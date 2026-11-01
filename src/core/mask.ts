/**
 * Payment instructions never reach a model. A page that prints wire or account instructions is
 * replaced before any request is built, so no prompt, however it is worded, can send it, and a
 * page that tries to instruct the reader ("send the funds to...") can't. The model readers' schema
 * has no field for payment data either, and a test fails if a canary from a synthetic wire page
 * appears in any recorded request.
 */

import type { Doc } from "./evidence.ts";

export const PAYMENT_INSTRUCTIONS: readonly RegExp[] = [
  /\bwire\s+(?:transfer\s+)?instructions\b/i,
  /\bwiring\s+instructions\b/i,
  /\bABA\b/,
  /\brouting\s*(?:no\.?|number|#|\(ABA\))/i,
  /\b(?:receiving|beneficiary|intermediary)\s+bank\b/i,
  /\b(?:SWIFT|BIC|IBAN)\b/,
  /^\s*(?:bank\s+)?account(?:\s+(?:no\.?|number|#))?\s*:/im,
];

export const WITHHELD = "[This page was withheld before any model call: it prints payment instructions.]";

export interface Masked {
  readonly docs: readonly Doc[];
  readonly withheld: readonly { readonly doc: string; readonly page: number }[];
}

export function maskPayments(docs: readonly Doc[]): Masked {
  const withheld: { doc: string; page: number }[] = [];
  const masked = docs.map((d) => ({
    ...d,
    pages: d.pages.map((p) => {
      if (!PAYMENT_INSTRUCTIONS.some((pattern) => pattern.test(p.text))) return p;
      withheld.push({ doc: d.id, page: p.n });
      return { ...p, text: WITHHELD };
    }),
  }));
  return { docs: masked, withheld };
}
