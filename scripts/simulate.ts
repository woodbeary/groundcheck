/**
 * Simulated recordings for the two model readers on layout B, written in the documented Messages
 * API response shapes so CI can exercise the request builders, the parsers, the gate and the
 * eval without a key. They are not a model's output. Each starts from what is printed (the
 * generator's ideal proposals) and plants mistakes of the kinds a model reader makes:
 *
 * reader A (JSON with quotes): a lien amount backed by the statement's clean number (alta-05), a
 * Part I requirement quoted as a Part II exception's kind (alta-06), a paraphrased beneficiary
 * (alta-07), a "dated" day quoted as the recording date (alta-10), and a response cut off at
 * max_tokens (alta-12);
 * reader B (native citations): the "dated" day given as the recording date while citing the
 * right item, which a block-level citation can't tell apart (alta-01), the statement's block cited
 * for a lien amount (alta-05), a Part I block cited for an exception's kind (alta-06), and a
 * refusal (alta-11).
 *
 * Both readers propose the intended value for every garbled one (alta-02, alta-03, alta-09), the
 * way a model "repairs" a garble; the gate has to hold each. Replace these with live recordings
 * (`node scripts/record.ts --live`) and pin the eval baseline again.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile, type LoanFile } from "../src/core/file.ts";
import { documentsOf } from "../src/readers/claude-citations.ts";
import type { Proposal } from "../src/readers/proposals.ts";
import { MODEL_READERS, RECORDINGS, recordingPath, type Recording } from "../src/readers/recordings.ts";
import { MODEL } from "../src/readers/render.ts";
import { layoutB, render, type Generated, type Ideal } from "./layout-b.ts";

const squash = (t: string) => t.replace(/\s+/g, " ").trim();

function proposals(g: Generated): Proposal[] {
  return g.ideal.map((i: Ideal) => ({ doc: i.doc, page: i.page, field: i.field, value: i.value, quote: i.quote }));
}

function replace(list: Proposal[], doc: string, field: string, change: Partial<Proposal>): Proposal[] {
  let hit = false;
  const out = list.map((p) => {
    if (p.doc !== doc || p.field !== field) return p;
    hit = true;
    return { ...p, ...change };
  });
  if (!hit) throw new Error(`no proposal ${doc}|${field}`);
  return out;
}

function line(file: LoanFile<unknown>, doc: string, page: number, starts: string): string {
  const text = file.docs.find((d) => d.id === doc)!.pages.find((p) => p.n === page)!.text;
  return text.split("\n").find((l) => l.startsWith(starts))!;
}

function pageOf(file: LoanFile<unknown>, doc: string): number {
  return file.docs.find((d) => d.id === doc)!.pages[0]!.n;
}

type Plan = (list: Proposal[], file: LoanFile<unknown>) => { proposals: Proposal[]; stop?: "max_tokens" | "refusal"; note: string };

const STATEMENT_CLEAN: Plan = (list, file) => ({
  proposals: replace(list, "commitment", "item 8 amount", { citedDoc: "first-statement", page: pageOf(file, "first-statement"), quote: "Original Principal: $412,000.00" }),
  note: "backs the deed of trust's amount with the statement's original principal",
});
const PART_I_KIND: Plan = (list, file) => ({
  proposals: replace(list, "commitment", "item 8 kind", { page: 2, quote: line(file, "commitment", 2, "5. ") }),
  note: "quotes Part I requirement 5 as Part II exception 8's kind",
});

const PLANS: Readonly<Record<string, Readonly<Record<string, Plan>>>> = {
  "claude-json": {
    "alta-05": STATEMENT_CLEAN,
    "alta-06": PART_I_KIND,
    "alta-07": (list) => ({ proposals: replace(list, "commitment", "item 9 holder", { value: "Bramblecrest FCU", quote: "Beneficiary: Bramblecrest FCU" }), note: "paraphrases the line of credit's beneficiary" }),
    "alta-10": (list) => ({ proposals: replace(list, "commitment", "item 8 recorded", { value: "2021-02-26", quote: "dated February 26, 2021" }), note: "quotes the deed's dated day as its recording date" }),
    "alta-12": (list) => ({ proposals: list, stop: "max_tokens", note: "the response is cut off at max_tokens" }),
  },
  "claude-citations": {
    "alta-01": (list) => ({ proposals: replace(list, "commitment", "item 8 recorded", { value: "2021-02-26" }), note: "gives the deed's dated day as its recording date, citing the right item" }),
    "alta-05": STATEMENT_CLEAN,
    "alta-06": PART_I_KIND,
    "alta-11": (list) => ({ proposals: list, stop: "refusal", note: "the model declines" }),
  },
};

function readerJson(list: readonly Proposal[], file: LoanFile<unknown>): unknown {
  const at = (doc: string, field: string) => {
    const p = list.find((x) => x.doc === doc && x.field === field);
    return p ? { value: p.value, doc: p.citedDoc ?? p.doc, page: p.page, quote: p.quote } : null;
  };
  const reportDocs = [...new Set(list.filter((p) => p.field === "effective date" || p.field.startsWith("item ")).map((p) => p.doc))];
  const statementDocs = [...new Set(list.filter((p) => ["statement date", "original principal", "principal balance"].includes(p.field)).map((p) => p.doc))];
  return {
    reports: reportDocs.map((doc) => ({
      doc,
      effective: at(doc, "effective date"),
      items: [...new Set(list.filter((p) => p.doc === doc && p.field.startsWith("item ")).map((p) => Number(p.field.split(" ")[1])))].map((n) => ({
        number: n,
        kind: at(doc, `item ${n} kind`),
        recorded: at(doc, `item ${n} recorded`),
        instrument: at(doc, `item ${n} instrument`),
        amount: at(doc, `item ${n} amount`),
        holder: at(doc, `item ${n} holder`),
      })),
    })),
    statements: statementDocs.map((doc) => ({ doc, date: at(doc, "statement date"), original: at(doc, "original principal"), balance: at(doc, "principal balance") })),
  };
}

function citedContent(list: readonly Proposal[], file: LoanFile<unknown>): unknown[] {
  const pages = documentsOf(file.docs);
  return list.flatMap((p) => {
    const index = pages.findIndex((d) => d.doc === (p.citedDoc ?? p.doc) && d.page === p.page);
    const page = pages[index]!;
    const block = page.blocks.findIndex((b) => squash(b).includes(squash(p.quote)));
    if (block < 0) throw new Error(`no block on ${page.doc} page ${page.page} prints "${p.quote}"`);
    return [
      { type: "text", text: `${p.doc}|${p.field}: ` },
      {
        type: "text",
        text: String(p.value),
        citations: [{ type: "content_block_location", cited_text: page.blocks[block], document_index: index, document_title: `${page.doc} page ${page.page}`, start_block_index: block, end_block_index: block + 1 }],
      },
      { type: "text", text: "\n" },
    ];
  });
}

export function simulate(reader: string, g: Generated): Recording {
  const model = MODEL_READERS[reader]!;
  const source = render(g.json);
  const file = parseFile<unknown>(g.json, source);
  const plan = PLANS[reader]?.[g.id];
  const planned = plan ? plan(proposals(g), file) : { proposals: proposals(g), note: "proposes exactly what is printed" };
  const thinking = { type: "thinking", thinking: "", signature: "simulated" };
  let content: unknown[];
  if (planned.stop === "refusal") content = [];
  else if (reader === "claude-json") {
    const text = JSON.stringify(readerJson(planned.proposals, file));
    content = [thinking, { type: "text", text: planned.stop === "max_tokens" ? text.slice(0, Math.floor(text.length / 2)) : text }];
  } else content = [thinking, ...citedContent(planned.proposals, file)];
  return {
    reader,
    file: g.id,
    kind: "simulated",
    promptSha: model.promptSha,
    fileSha256: file.sha256,
    recordedAt: "2026-11-01T00:00:00Z",
    note: `simulated, not model output: ${planned.note}`,
    request: model.build(file.docs),
    response: {
      id: `msg_simulated_${reader}_${g.id}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content,
      stop_reason: planned.stop ?? "end_turn",
      stop_sequence: null,
      ...(planned.stop === "refusal" ? { stop_details: { type: "refusal", category: null, explanation: "simulated refusal" } } : {}),
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Recording["response"],
  };
}

export function simulated(): Recording[] {
  return Object.keys(PLANS).flatMap((reader) => layoutB().map((g) => simulate(reader, g)));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  for (const r of simulated()) {
    const path = recordingPath(r.reader, r.file, RECORDINGS);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, render(r));
  }
  console.log(`wrote simulated recordings to ${RECORDINGS}`);
}
