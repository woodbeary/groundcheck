/**
 * Flat proposals (field, value, document, page, quote), the shape a model or a vendor returns,
 * turned into the reading lienstack gates. Nothing is checked here: a proposal for a document,
 * page or item that doesn't exist is passed on as given, and the gate rejects it with the reason.
 */

import type { Claim } from "../core/evidence.ts";
import type { ItemReading, LienKind, ReportReading, StatementReading, TitleReading } from "../lienstack/types.ts";

export interface Proposal {
  /** The document the value belongs to: the report an item is on, or the statement. */
  readonly doc: string;
  /** The document the quote is from, when the reader cites another one (the gate will refuse it). */
  readonly citedDoc?: string;
  readonly page: number;
  /** "effective date", "item 8 amount", "statement date", "original principal", "principal balance". */
  readonly field: string;
  readonly value: string | number;
  readonly quote: string;
}

const ITEM = /^item (\d{1,2}) (kind|recorded|instrument|amount|holder)$/;
const STATEMENT_FIELDS = { "statement date": "date", "original principal": "original", "principal balance": "balance" } as const;

function claim<T>(p: Proposal, value: T): Claim<T> {
  return { field: p.field, value, cite: { doc: p.citedDoc ?? p.doc, page: p.page, span: p.quote } };
}

export function fromProposals(proposals: readonly Proposal[], readerNote?: string): TitleReading {
  const reports = new Map<string, { effective?: Claim<string>; items: Map<number, Partial<Record<"kind" | "recorded" | "instrument" | "amount" | "holder", Proposal>>> }>();
  const statements = new Map<string, Partial<Record<"date" | "original" | "balance", Proposal>>>();
  const report = (doc: string) => reports.get(doc) ?? reports.set(doc, { items: new Map() }).get(doc)!;
  for (const p of proposals) {
    const item = ITEM.exec(p.field);
    if (p.field === "effective date") report(p.doc).effective = claim(p, String(p.value));
    else if (item) {
      const items = report(p.doc).items;
      const number = Number(item[1]);
      const slot = items.get(number) ?? items.set(number, {}).get(number)!;
      slot[item[2] as "kind"] = p;
    } else if (p.field in STATEMENT_FIELDS) {
      const s = statements.get(p.doc) ?? statements.set(p.doc, {}).get(p.doc)!;
      s[STATEMENT_FIELDS[p.field as keyof typeof STATEMENT_FIELDS]] = p;
    }
  }
  const readReports: ReportReading[] = [...reports].map(([doc, r]) => ({
    doc,
    ...(r.effective ? { effective: r.effective } : {}),
    items: [...r.items]
      .filter(([, slot]) => slot.kind)
      .map(([number, slot]): ItemReading => ({
        number,
        kind: claim(slot.kind!, String(slot.kind!.value) as LienKind),
        ...(slot.recorded ? { recorded: claim(slot.recorded, String(slot.recorded.value)) } : {}),
        ...(slot.instrument ? { instrument: claim(slot.instrument, String(slot.instrument.value)) } : {}),
        ...(slot.amount ? { amount: claim(slot.amount, Number(slot.amount.value)) } : {}),
        ...(slot.holder ? { holder: claim(slot.holder, String(slot.holder.value)) } : {}),
      })),
  }));
  const readStatements: StatementReading[] = [...statements].map(([doc, s]) => ({
    doc,
    ...(s.date ? { date: claim(s.date, String(s.date.value)) } : {}),
    ...(s.original ? { original: claim(s.original, Number(s.original.value)) } : {}),
    ...(s.balance ? { balance: claim(s.balance, Number(s.balance.value)) } : {}),
  }));
  return readerNote === undefined ? { reports: readReports, statements: readStatements } : { reports: readReports, statements: readStatements, readerNote };
}
