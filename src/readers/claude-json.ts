/**
 * Model reader A: JSON with quotes. One Messages API request with structured outputs
 * (`output_config.format`, a JSON schema), in which every value carries the document, page and
 * quote that print it, and the citation gate checks each quote. A refusal, a response cut off at
 * max_tokens, or JSON that doesn't match the schema is no reading at all, never an empty one, so
 * every fact it would have backed stays as wide as a missing page.
 *
 * The schema has no field for payment or account data, and the pages are masked before the
 * request is built. Numeric bounds can't be expressed in a structured-output schema; range checks
 * are code's job anyway.
 */

import { createHash } from "node:crypto";
import type { Doc } from "../core/evidence.ts";
import type { Proposal } from "./proposals.ts";
import { KINDS, MODEL, RULES, renderDocs } from "./render.ts";

const field = (value: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["value", "doc", "page", "quote"],
  properties: { value, doc: { type: "string" }, page: { type: "integer" }, quote: { type: "string" } },
});
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const DATE = field({ type: "string", format: "date" });
const MONEY = field({ type: "number" });
const TEXT = field({ type: "string" });

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reports", "statements"],
  properties: {
    reports: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["doc", "effective", "items"],
        properties: {
          doc: { type: "string" },
          effective: nullable(DATE),
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["number", "kind", "recorded", "instrument", "amount", "holder"],
              properties: {
                number: { type: "integer" },
                kind: field({ type: "string", enum: [...KINDS] }),
                recorded: nullable(DATE),
                instrument: nullable(TEXT),
                amount: nullable(MONEY),
                holder: nullable(TEXT),
              },
            },
          },
        },
      },
    },
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["doc", "date", "original", "balance"],
        properties: { doc: { type: "string" }, date: nullable(DATE), original: nullable(MONEY), balance: nullable(MONEY) },
      },
    },
  },
} as const;

export const SYSTEM = [
  RULES,
  "Return JSON matching the schema. Every value carries the document id, the page number and a quote copied exactly from that page: the shortest text that prints the value with its label (for example \"recorded March 3, 2021\", \"Document No. 2021-0123456\" or \"Original Principal: $412,000.00\").",
  "For an item's kind, quote the whole numbered item, every line of it. Use null for a field the item doesn't print.",
].join("\n");

const PARAMS = { model: MODEL, max_tokens: 16000, output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } } } as const;

/** SHA-256 of everything in the request except the file's own pages. */
export const PROMPT_SHA = createHash("sha256").update(JSON.stringify({ ...PARAMS, system: SYSTEM })).digest("hex");

export function buildRequest(docs: readonly Doc[]): Record<string, unknown> {
  return { ...PARAMS, system: SYSTEM, messages: [{ role: "user", content: renderDocs(docs) }] };
}

interface Field<T> {
  value: T;
  doc: string;
  page: number;
  quote: string;
}

interface ReaderJson {
  reports: { doc: string; effective: Field<string> | null; items: { number: number; kind: Field<string>; recorded: Field<string> | null; instrument: Field<string> | null; amount: Field<number> | null; holder: Field<string> | null }[] }[];
  statements: { doc: string; date: Field<string> | null; original: Field<number> | null; balance: Field<number> | null }[];
}

function isField(v: unknown, kind: "string" | "number"): boolean {
  const f = v as Field<unknown>;
  return typeof f === "object" && f !== null && typeof f.value === kind && typeof f.doc === "string" && Number.isInteger(f.page) && typeof f.quote === "string";
}

const maybe = (v: unknown, kind: "string" | "number") => v === null || isField(v, kind);

function asReaderJson(v: unknown): ReaderJson {
  const r = v as ReaderJson;
  const ok =
    typeof r === "object" &&
    r !== null &&
    Array.isArray(r.reports) &&
    Array.isArray(r.statements) &&
    r.reports.every(
      (rep) =>
        typeof rep.doc === "string" &&
        maybe(rep.effective, "string") &&
        Array.isArray(rep.items) &&
        rep.items.every((i) => Number.isInteger(i.number) && isField(i.kind, "string") && maybe(i.recorded, "string") && maybe(i.instrument, "string") && maybe(i.amount, "number") && maybe(i.holder, "string")),
    ) &&
    r.statements.every((s) => typeof s.doc === "string" && maybe(s.date, "string") && maybe(s.original, "number") && maybe(s.balance, "number"));
  if (!ok) throw new Error("the response doesn't match the schema");
  return r;
}

/** The parts of a Messages API response a reader reads; anything else in it is kept as recorded. */
export interface MessageResponse {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly stop_details?: { readonly type?: string; readonly category?: string | null; readonly explanation?: string | null } | null;
  readonly content?: readonly { readonly type: string; readonly text?: string; readonly citations?: readonly unknown[] | null }[];
  readonly [key: string]: unknown;
}

/** Why a response is no reading, or null when it can be read. */
export function noReading(response: MessageResponse): string | null {
  if (response.stop_reason === "refusal") return `the model declined (stop_reason refusal${response.stop_details?.category ? `, ${response.stop_details.category}` : ""})`;
  if (response.stop_reason === "max_tokens") return "the response was cut off at max_tokens";
  return null;
}

export function parseResponse(response: MessageResponse): { proposals: Proposal[] } | { noReading: string } {
  const why = noReading(response);
  if (why) return { noReading: why };
  const text = response.content?.find((b) => b.type === "text")?.text;
  if (text === undefined) return { noReading: "the response has no text block" };
  let json: ReaderJson;
  try {
    json = asReaderJson(JSON.parse(text));
  } catch (error) {
    return { noReading: error instanceof SyntaxError ? "the response is not JSON" : (error as Error).message };
  }
  const proposals: Proposal[] = [];
  const add = (subject: string, name: string, f: Field<string | number> | null) => {
    if (f) proposals.push({ doc: subject, ...(f.doc === subject ? {} : { citedDoc: f.doc }), page: f.page, field: name, value: f.value, quote: f.quote });
  };
  for (const rep of json.reports) {
    add(rep.doc, "effective date", rep.effective);
    for (const i of rep.items) {
      add(rep.doc, `item ${i.number} kind`, i.kind);
      add(rep.doc, `item ${i.number} recorded`, i.recorded);
      add(rep.doc, `item ${i.number} instrument`, i.instrument);
      add(rep.doc, `item ${i.number} amount`, i.amount);
      add(rep.doc, `item ${i.number} holder`, i.holder);
    }
  }
  for (const s of json.statements) {
    add(s.doc, "statement date", s.date);
    add(s.doc, "original principal", s.original);
    add(s.doc, "principal balance", s.balance);
  }
  return { proposals };
}
