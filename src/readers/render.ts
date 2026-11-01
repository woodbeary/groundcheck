/**
 * What a model reader is shown, built the same way for every request: the file's pages after
 * payment instructions are withheld, each tagged with its document id and physical page number,
 * which are what a proposal has to cite.
 */

import type { Doc } from "../core/evidence.ts";
import { maskPayments } from "../core/mask.ts";

export const MODEL = "claude-opus-5-5";

export const KINDS = ["deed-of-trust", "credit-line-deed-of-trust", "reverse-mortgage", "tax-lien", "judgment", "subordination", "property-taxes", "other-lien", "other"] as const;

export const FIELDS_GUIDE = [
  "Kinds: deed-of-trust; credit-line-deed-of-trust (a line of credit or revolving deed of trust); reverse-mortgage; tax-lien (a recorded tax lien);",
  "judgment; subordination (a subordination agreement); property-taxes (taxes printed as a lien not yet due or payable); other-lien (a recorded",
  "lien none of these name, such as a mechanic's lien); other (anything that is not a recorded lien: easements, covenants, standard exceptions).",
].join(" ");

export const RULES = [
  "You read synthetic title documents for a checker. You only propose values; code decides which ones stand.",
  "Read a title report's Schedule B exceptions (Part II of a commitment, or Schedule B of a preliminary report). Part I requirements and Schedule A lines are not items.",
  "List every numbered exception, including the standard ones, with its kind, and read the effective or commitment date of every report.",
  "For each mortgage statement or line-of-credit statement, read the statement date, the original principal or credit limit, and the principal balance.",
  "Never correct a printed value. If a value looks garbled (digits run together, two values in one, a footnote mark), quote it exactly as printed and give your best reading; the checker decides.",
  "Pages marked as withheld are not available to you. Never repeat payment or account instructions.",
  FIELDS_GUIDE,
].join("\n");

/** The masked pages, as plain text with their document id and page number. */
export function renderDocs(docs: readonly Doc[]): string {
  return maskPayments(docs)
    .docs.map((d) => [`<document id="${d.id}">`, ...d.pages.map((p) => `<page n="${p.n}">\n${p.text}\n</page>`), "</document>"].join("\n"))
    .join("\n");
}

/**
 * A page split into citable blocks: each line is a block, and a line that starts with
 * whitespace carries on the block before it, so a numbered item that wraps is one block.
 */
export function pageBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) && blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
    else if (line.trim()) blocks.push(line);
  }
  return blocks;
}
