/**
 * Page routing. The reference router scores printed phrases; a model or a vendor classifier can
 * stand in its place. Whatever labels the page, a label it is less sure of than the policy's
 * floor becomes UNCERTAIN: that page goes to a person and is counted, and nothing on it reaches
 * the reader, so its facts stay as wide as if the page were missing.
 */

import type { Doc, Page } from "../core/evidence.ts";
import type { PageClass, Routed, Router } from "./types.ts";

const SIGNALS: Record<Exclude<PageClass, "UNCERTAIN">, readonly RegExp[]> = {
  RENT_SCHEDULE: [/comparable rent schedule/i, /market rent/i],
  LEGAL_DOCUMENT: [/lease agreement/i, /promissory note/i, /\btenant\b/i, /borrower promises to pay/i],
  FINANCIAL_DATA: [/property tax bill/i, /insurance declarations/i, /association statement/i, /annual premium|annual tax|monthly assessment/i],
  PROPERTY_INFO: [/appraisal report/i, /property inspection/i],
  COVER_SHEET: [/cover sheet/i, /table of contents/i],
  IRRELEVANT: [/intentionally left blank/i, /advertisement/i],
};

export const keywordRouter: Router = (page) => {
  const scores = Object.entries(SIGNALS).map(([cls, signals]) => ({
    cls: cls as Exclude<PageClass, "UNCERTAIN">,
    hits: signals.filter((s) => s.test(page.text)).length,
  }));
  const total = scores.reduce((n, s) => n + s.hits, 0);
  const best = scores.reduce((a, b) => (b.hits > a.hits ? b : a));
  return { cls: best.cls, confidence: total === 0 ? 0 : best.hits / total };
};

export function route(docs: readonly Doc[], router: Router, floor: number): Routed[] {
  return docs.flatMap((doc) =>
    doc.pages.map((page: Page) => {
      const { cls, confidence } = router(page);
      return { doc: doc.id, page: page.n, cls: confidence >= floor ? cls : "UNCERTAIN", confidence };
    }),
  );
}

/** Classes whose pages the reader may read. */
export const READABLE: readonly PageClass[] = ["RENT_SCHEDULE", "LEGAL_DOCUMENT", "FINANCIAL_DATA", "PROPERTY_INFO"];
