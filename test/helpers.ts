import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFile, type LoanFile } from "../src/core/file.ts";

export const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

export function example<R>(kind: "title" | "dscr", id: string): LoanFile<R> {
  return loadFile<R>(join(EXAMPLES, kind, `${id}.json`));
}

export function examples<R>(kind: "title" | "dscr"): LoanFile<R>[] {
  return readdirSync(join(EXAMPLES, kind))
    .filter((name) => /^(title|dscr)-\d+\.json$/.test(name))
    .sort()
    .map((name) => loadFile<R>(join(EXAMPLES, kind, name)));
}

/** The same file with one printed phrase changed, to build a variant without another fixture. */
export function edit<R>(file: LoanFile<R>, from: string, to: string): LoanFile<R> {
  let hits = 0;
  const docs = file.docs.map((d) => ({
    ...d,
    pages: d.pages.map((p) => {
      if (!p.text.includes(from)) return p;
      hits += 1;
      return { ...p, text: p.text.replace(from, to) };
    }),
  }));
  if (hits !== 1) throw new Error(`expected "${from}" on exactly one page of ${file.id}, found ${hits}`);
  return { ...file, docs };
}

export function withRequest<R>(file: LoanFile<R>, change: Partial<R>): LoanFile<R> {
  return { ...file, request: { ...file.request, ...change } };
}
