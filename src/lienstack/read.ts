/**
 * The reference reader for this repository's synthetic title files. It stands where a model or a
 * vendor extractor would: it only proposes values with the text that prints them, and the check
 * accepts nothing it can't find on the cited page. It is written for these fixtures' layout and
 * makes no claim about real title reports.
 */

import { dateTokens } from "../core/dates.ts";
import type { Claim, Doc, Page } from "../core/evidence.ts";
import { kindOf, type ItemReading, type ReportReading, type StatementReading, type TitleReading } from "./types.ts";

const REPORT = /PRELIMINARY REPORT|OWNERSHIP AND ENCUMBRANCE REPORT/i;
const STATEMENT = /MORTGAGE STATEMENT|LINE OF CREDIT STATEMENT/i;

function lines(page: Page): string[] {
  return page.text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function cite<T>(doc: Doc, page: Page, field: string, value: T, span: string): Claim<T> {
  return { field, value, cite: { doc: doc.id, page: page.n, span } };
}

function firstDate(text: string): string {
  return dateTokens(text)[0]?.value ?? "";
}

function dollars(token: string): number {
  return Number(token.replace(/[^\d.]/g, ""));
}

function find(doc: Doc, pattern: RegExp): { page: Page; line: string; m: RegExpExecArray } | undefined {
  for (const page of doc.pages) {
    for (const line of lines(page)) {
      const m = pattern.exec(line);
      if (m) return { page, line, m };
    }
  }
  return undefined;
}

function readItem(doc: Doc, page: Page, number: number, line: string): ItemReading {
  const at = <T>(field: string, value: T, span: string) => cite(doc, page, `item ${number} ${field}`, value, span);
  const recorded = /recorded\s+(?:on\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d+|\d{1,2}\/\d{1,2}\/\d+)/i.exec(line);
  const instrument = /Instrument No\.?\s*([\w-]+)/i.exec(line);
  const amount = /(?:amount of|for)\s+(\$\s?\d[\d,.$%*]*)/i.exec(line);
  const holder = /(?:Beneficiary|Creditor|Lender):\s*([^.;]+)/i.exec(line);
  return {
    number,
    kind: at("kind", kindOf(line), line),
    ...(recorded ? { recorded: at("recorded", firstDate(recorded[1]!), recorded[0]) } : {}),
    ...(instrument ? { instrument: at("instrument", instrument[1]!, instrument[0]) } : {}),
    ...(amount ? { amount: at("amount", dollars(amount[1]!), amount[0]) } : {}),
    ...(holder ? { holder: at("holder", holder[1]!.trim(), holder[0]) } : {}),
  };
}

function readReport(doc: Doc): ReportReading {
  const effective = find(doc, /^Effective Date:\s*(.+)$/i);
  const items = doc.pages
    .filter((page) => /SCHEDULE B/i.test(page.text))
    .flatMap((page) =>
      lines(page).flatMap((line) => {
        const m = /^(\d{1,2})\.\s+(.*)$/.exec(line);
        return m ? [readItem(doc, page, Number(m[1]), line)] : [];
      }),
    );
  return {
    doc: doc.id,
    ...(effective ? { effective: cite(doc, effective.page, "effective date", firstDate(effective.m[1]!), effective.line) } : {}),
    items,
  };
}

function readStatement(doc: Doc): StatementReading {
  const date = find(doc, /^Statement Date:\s*(.+)$/i);
  const original = find(doc, /^(?:Original Principal(?: Amount)?|Credit Limit):\s*(\$\s?\S+)/i);
  const balance = find(doc, /^(?:Unpaid )?Principal Balance:\s*(\$\s?\S+)/i);
  return {
    doc: doc.id,
    ...(date ? { date: cite(doc, date.page, "statement date", firstDate(date.m[1]!), date.line) } : {}),
    ...(original ? { original: cite(doc, original.page, "original principal", dollars(original.m[1]!), original.line) } : {}),
    ...(balance ? { balance: cite(doc, balance.page, "principal balance", dollars(balance.m[1]!), balance.line) } : {}),
  };
}

export function readTitle(docs: readonly Doc[]): TitleReading {
  return {
    reports: docs.filter((d) => d.pages.some((p) => REPORT.test(p.text))).map(readReport),
    statements: docs.filter((d) => d.pages.some((p) => STATEMENT.test(p.text))).map(readStatement),
  };
}
