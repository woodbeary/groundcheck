/**
 * Model reader B: Claude's native citations. Each page goes in as a custom-content document whose
 * blocks are its lines, with a wrapped Schedule B item kept whole as one block, so a citation can
 * only point at a whole item or a whole line. The model writes one line per value,
 * `<doc>|<field>: <value>`, and cites the block that prints it. Citations and structured outputs
 * can't share a request (the API returns a 400), so this is a separate reader scored by the same
 * gate as reader A.
 *
 * A citation's pointer is guaranteed to name a block that exists. It doesn't make the value right:
 * the value is read from the model's own text, and the gate still requires the cited block to
 * print it, on the right document, inside the right item.
 */

import { createHash } from "node:crypto";
import type { Doc } from "../core/evidence.ts";
import { maskPayments } from "../core/mask.ts";
import { noReading, type MessageResponse } from "./claude-json.ts";
import type { Proposal } from "./proposals.ts";
import { MODEL, RULES, pageBlocks } from "./render.ts";

export const SYSTEM = [
  RULES,
  "Write one line per value, exactly in the form `<document id>|<field>: <value>`, and cite the block that prints the value.",
  "Fields: `effective date`, `item N kind`, `item N recorded`, `item N instrument`, `item N amount`, `item N holder`, `statement date`, `original principal`, `principal balance`.",
  "Write dates as YYYY-MM-DD and amounts as plain numbers. Leave out a field the document doesn't print. Write nothing else.",
].join("\n");

const PARAMS = { model: MODEL, max_tokens: 16000, output_config: { effort: "medium" } } as const;

export const PROMPT_SHA = createHash("sha256").update(JSON.stringify({ ...PARAMS, system: SYSTEM, documents: "one custom-content document per page; one block per line, wrapped items whole" })).digest("hex");

export interface PageDocument {
  readonly doc: string;
  readonly page: number;
  readonly blocks: readonly string[];
}

/** The documents in request order: `document_index` in a citation is an index into this list. */
export function documentsOf(docs: readonly Doc[]): PageDocument[] {
  return maskPayments(docs).docs.flatMap((d) => d.pages.map((p) => ({ doc: d.id, page: p.n, blocks: pageBlocks(p.text) })));
}

export function buildRequest(docs: readonly Doc[]): Record<string, unknown> {
  const pages = documentsOf(docs);
  return {
    ...PARAMS,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...pages.map((p) => ({ type: "document", source: { type: "content", content: p.blocks.map((text) => ({ type: "text", text })) }, title: `${p.doc} page ${p.page}`, citations: { enabled: true } })),
          { type: "text", text: "Read these documents. Each document is one page; its title names the document id and the page number." },
        ],
      },
    ],
  };
}

interface BlockCitation {
  readonly type: string;
  readonly document_index?: number;
  readonly start_block_index?: number;
  readonly end_block_index?: number;
}

const LINE = /^\s*([^|\s][^|]*)\|([^:]+):\s*(.*?)\s*$/;
const NUMERIC = /^(?:item \d{1,2} amount|original principal|principal balance)$/;

/** The model's lines, each with the citations of the text that wrote it. */
function citedLines(response: MessageResponse): { text: string; citations: BlockCitation[] }[] {
  const lines: { text: string; citations: BlockCitation[] }[] = [{ text: "", citations: [] }];
  for (const block of response.content ?? []) {
    if (block.type !== "text" || block.text === undefined) continue;
    const parts = block.text.split("\n");
    for (const [i, part] of parts.entries()) {
      if (i > 0) lines.push({ text: "", citations: [] });
      const line = lines[lines.length - 1]!;
      line.text += part;
      if (part.trim() || parts.length === 1) line.citations.push(...((block.citations ?? []) as BlockCitation[]));
    }
  }
  return lines.filter((l) => l.text.trim());
}

/**
 * Proposals from a cited response. The quote is the text of the blocks the citation points at,
 * taken from the request itself; a line with no content-block citation proposes nothing.
 */
export function parseResponse(response: MessageResponse, docs: readonly Doc[]): { proposals: Proposal[] } | { noReading: string } {
  const why = noReading(response);
  if (why) return { noReading: why };
  const pages = documentsOf(docs);
  const proposals: Proposal[] = [];
  for (const line of citedLines(response)) {
    const m = LINE.exec(line.text);
    const cite = line.citations.find((c) => c.type === "content_block_location");
    if (!m || !cite) continue;
    const page = pages[cite.document_index ?? -1];
    if (!page) continue;
    const quote = page.blocks.slice(cite.start_block_index ?? 0, cite.end_block_index ?? 0).join("\n");
    const [, subject, rawField, rawValue] = m;
    const field = rawField!.trim();
    const value = NUMERIC.test(field) ? Number(rawValue!.replace(/[$,]/g, "")) : rawValue!;
    proposals.push({ doc: subject!.trim(), ...(page.doc === subject!.trim() ? {} : { citedDoc: page.doc }), page: page.page, field, value, quote });
  }
  return { proposals };
}
