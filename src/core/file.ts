import { readFileSync } from "node:fs";
import type { Doc } from "./evidence.ts";

/** A synthetic loan file: the documents as page text, plus the request it is checked against. */
export interface LoanFile<R> {
  readonly id: string;
  readonly synthetic: true;
  readonly request: R;
  readonly docs: readonly Doc[];
}

interface RawPage {
  n: number;
  lines: string[];
}

interface RawFile {
  id: string;
  synthetic: boolean;
  request: unknown;
  docs: { id: string; pages: RawPage[] }[];
}

function isRaw(value: unknown): value is RawFile {
  const v = value as RawFile;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    Array.isArray(v.docs) &&
    v.docs.every((d) => typeof d.id === "string" && Array.isArray(d.pages) && d.pages.every((p) => Number.isInteger(p.n) && Array.isArray(p.lines)))
  );
}

/** Only files marked synthetic are accepted, so a real loan file can't be dropped in by accident. */
export function parseFile<R>(value: unknown): LoanFile<R> {
  if (!isRaw(value)) throw new Error("not a loan file: expected { id, synthetic, request, docs[{ id, pages[{ n, lines }] }] }");
  if (value.synthetic !== true) throw new Error(`${value.id}: only synthetic files are accepted`);
  return {
    id: value.id,
    synthetic: true,
    request: value.request as R,
    docs: value.docs.map((d) => ({ id: d.id, pages: d.pages.map((p) => ({ n: p.n, text: p.lines.join("\n") })) })),
  };
}

export function loadFile<R>(path: string): LoanFile<R> {
  return parseFile<R>(JSON.parse(readFileSync(path, "utf8")));
}

/** The same file with some physical pages gone, as if they never arrived. */
export function withoutPages<R>(file: LoanFile<R>, gone: readonly { doc: string; n: number }[]): LoanFile<R> {
  const isGone = (doc: string, n: number) => gone.some((g) => g.doc === doc && g.n === n);
  return {
    ...file,
    docs: file.docs.map((d) => ({ ...d, pages: d.pages.filter((p) => !isGone(d.id, p.n)) })).filter((d) => d.pages.length > 0),
  };
}

export function allPages(file: LoanFile<unknown>): { doc: string; n: number }[] {
  return file.docs.flatMap((d) => d.pages.map((p) => ({ doc: d.id, n: p.n })));
}
