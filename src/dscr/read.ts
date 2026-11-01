/**
 * The reference reader for this repository's synthetic DSCR files. Like the title reader, it
 * stands where a model or a vendor extractor would, proposes values with the text that prints
 * them, and is written for these fixtures' layout only.
 */

import { dateTokens } from "../core/dates.ts";
import type { Claim, Doc, Page } from "../core/evidence.ts";
import { READABLE } from "./route.ts";
import type { DscrReading, Routed } from "./types.ts";

interface Hit {
  page: Page;
  line: string;
  m: RegExpExecArray;
}

function readablePages(doc: Doc, routed: readonly Routed[]): Page[] {
  return doc.pages.filter((p) => routed.some((r) => r.doc === doc.id && r.page === p.n && READABLE.includes(r.cls)));
}

function find(pages: readonly Page[], pattern: RegExp): Hit | undefined {
  for (const page of pages) {
    for (const line of page.text.split("\n").map((l) => l.trim())) {
      const m = pattern.exec(line);
      if (m) return { page, line, m };
    }
  }
  return undefined;
}

const dollars = (token: string) => Number(token.replace(/[^\d.]/g, ""));
const dates = (text: string) => dateTokens(text).map((t) => t.value ?? "");

function claim<T>(doc: Doc, hit: Hit | undefined, field: string, value: (m: RegExpExecArray) => T): Claim<T> | undefined {
  return hit ? { field, value: value(hit.m), cite: { doc: doc.id, page: hit.page.n, span: hit.line } } : undefined;
}

function fields<T extends object>(entries: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as T;
}

const MONEY = "(\\$\\s?\\d[\\d,.$%*]*)";

export function readDscr(docs: readonly Doc[], routed: readonly Routed[]): DscrReading {
  const reading = { appraisals: [], leases: [], notes: [], taxBills: [], insurance: [], dues: [] } as {
    [K in keyof DscrReading]: DscrReading[K][number][];
  };
  for (const doc of docs) {
    const pages = readablePages(doc, routed);
    const text = pages.map((p) => p.text).join("\n");
    const at = (pattern: string) => find(pages, new RegExp(pattern, "i"));
    if (/comparable rent schedule/i.test(text)) {
      reading.appraisals.push(
        fields({
          doc: doc.id,
          effective: claim(doc, at("^Effective Date of Appraisal:\\s*(.+)$"), "appraisal effective", (m) => dates(m[1]!)[0] ?? ""),
          marketRent: claim(doc, at(`^Estimated Monthly Market Rent:\\s*${MONEY}`), "market rent", (m) => dollars(m[1]!)),
          noDues: claim(doc, at("^Association Dues:\\s*None\\b"), "no association dues", () => "none" as const),
        }),
      );
    } else if (/lease agreement/i.test(text)) {
      const term = at("^Term:\\s*(.+)$");
      reading.leases.push(
        fields({
          doc: doc.id,
          rent: claim(doc, at(`^Monthly Rent:\\s*${MONEY}`), "lease rent", (m) => dollars(m[1]!)),
          start: claim(doc, term, "lease start", (m) => dates(m[1]!)[0] ?? ""),
          end: claim(doc, term, "lease end", (m) => dates(m[1]!)[1] ?? ""),
        }),
      );
    } else if (/promissory note/i.test(text)) {
      reading.notes.push(
        fields({
          doc: doc.id,
          principal: claim(doc, at(`^Principal Amount:\\s*${MONEY}`), "principal", (m) => dollars(m[1]!)),
          rate: claim(doc, at("^Interest Rate:\\s*(\\S+)%"), "rate", (m) => Number(m[1])),
          termMonths: claim(doc, at("^Term:\\s*(\\S+)\\s+months"), "term", (m) => Number(m[1])),
          payment: claim(doc, at(`^Monthly Principal and Interest Payment:\\s*${MONEY}`), "principal and interest", (m) => dollars(m[1]!)),
        }),
      );
    } else if (/property tax bill/i.test(text)) {
      const year = at("^Fiscal Year:\\s*(.+)$");
      reading.taxBills.push(
        fields({
          doc: doc.id,
          from: claim(doc, year, "tax year start", (m) => dates(m[1]!)[0] ?? ""),
          to: claim(doc, year, "tax year end", (m) => dates(m[1]!)[1] ?? ""),
          annual: claim(doc, at(`^Total Annual Tax:\\s*${MONEY}`), "annual tax", (m) => dollars(m[1]!)),
        }),
      );
    } else if (/insurance declarations/i.test(text)) {
      const period = at("^Policy Period:\\s*(.+)$");
      reading.insurance.push(
        fields({
          doc: doc.id,
          from: claim(doc, period, "policy start", (m) => dates(m[1]!)[0] ?? ""),
          to: claim(doc, period, "policy end", (m) => dates(m[1]!)[1] ?? ""),
          annual: claim(doc, at(`^Total Annual Premium:\\s*${MONEY}`), "annual premium", (m) => dollars(m[1]!)),
        }),
      );
    } else if (/association statement/i.test(text)) {
      reading.dues.push(
        fields({
          doc: doc.id,
          date: claim(doc, at("^Statement Date:\\s*(.+)$"), "dues statement date", (m) => dates(m[1]!)[0] ?? ""),
          monthly: claim(doc, at(`^Monthly Assessment:\\s*${MONEY}`), "monthly dues", (m) => dollars(m[1]!)),
        }),
      );
    }
  }
  return reading;
}
