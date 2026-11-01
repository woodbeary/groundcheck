import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseFile, type LoanFile } from "../src/core/file.ts";
import { WITHHELD, maskPayments } from "../src/core/mask.ts";
import { lienstack, type LienRequest } from "../src/lienstack/index.ts";
import * as citations from "../src/readers/claude-citations.ts";
import * as json from "../src/readers/claude-json.ts";
import { MODEL_READERS, RECORDINGS, loadRecording, recordingPath, replayReader, stale, type Recording } from "../src/readers/recordings.ts";
import { layoutB, render } from "../scripts/layout-b.ts";
import { simulated } from "../scripts/simulate.ts";

const generated = layoutB();
const load = (id: string): LoanFile<LienRequest> => {
  const g = generated.find((x) => x.id === id)!;
  return parseFile<LienRequest>(g.json, render(g.json));
};
const CANARY = ["CANARY-WIRE-7F3E", "SYN-RT-0042", "SYN-ACCT-7781", "Synthetic Fixture Bank"];
const dir = mkdtempSync(join(tmpdir(), "groundcheck-recordings-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("wire and payment pages never reach a model", () => {
  it("withholds the page that prints wire instructions, and only that page", () => {
    const masked = maskPayments(load("alta-10").docs);
    assert.deepEqual(masked.withheld, [{ doc: "closing-instructions", page: 6 }]);
    assert.equal(masked.docs.find((d) => d.id === "closing-instructions")!.pages[0]!.text, WITHHELD);
    for (const g of generated.filter((x) => x.id !== "alta-10")) assert.deepEqual(maskPayments(load(g.id).docs).withheld, [], g.id);
  });

  it("builds no request, for either reader, that carries the canary from the synthetic wire page", () => {
    const file = load("alta-10");
    assert.ok(CANARY.every((c) => JSON.stringify(file.docs).includes(c)), "the fixture carries the canary");
    for (const reader of Object.values(MODEL_READERS)) {
      const body = JSON.stringify(reader.build(file.docs));
      for (const c of CANARY) assert.ok(!body.includes(c), `${reader.name} request carries ${c}`);
      assert.ok(body.includes("withheld before any model call"), reader.name);
    }
  });

  it("finds the canary in no recorded request", () => {
    const files = readdirSync(RECORDINGS, { recursive: true }).map(String).filter((p) => p.endsWith(".json"));
    assert.ok(files.length >= 24);
    for (const p of files) {
      const request = JSON.stringify((JSON.parse(readFileSync(join(RECORDINGS, p), "utf8")) as Recording).request);
      for (const c of CANARY) assert.ok(!request.includes(c), `${p} carries ${c}`);
    }
  });

  it("gives payment data no field in reader A's schema", () => {
    const names: string[] = [];
    const walk = (node: unknown): void => {
      if (node && typeof node === "object") {
        const props = (node as { properties?: Record<string, unknown> }).properties;
        if (props) names.push(...Object.keys(props));
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(json.SCHEMA);
    assert.ok(names.includes("amount"));
    assert.deepEqual(names.filter((n) => /wire|routing|account|bank|swift|iban|payment|aba/i.test(n)), []);
  });
});

describe("reader A: JSON with quotes through structured outputs", () => {
  it("asks for the schema through output_config.format, with no beta header field and no numeric bounds", () => {
    const body = json.buildRequest(load("alta-01").docs) as { model: string; output_config: { format: { type: string; schema: unknown } }; messages: { content: string }[] };
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.format.schema, json.SCHEMA);
    assert.ok(!("output_format" in body) && !("betas" in body) && !("thinking" in body));
    assert.doesNotMatch(JSON.stringify(json.SCHEMA), /"(minimum|maximum|minLength|maxLength|multipleOf)"/);
    assert.match(body.messages[0]!.content, /<page n="4">/);
    const strict = (node: unknown): boolean =>
      !node || typeof node !== "object" || (((node as { type?: string }).type !== "object" || ((node as { additionalProperties?: boolean }).additionalProperties === false && Object.keys((node as { properties: object }).properties).every((k) => (node as { required: string[] }).required.includes(k)))) && Object.values(node).every(strict));
    assert.ok(strict(json.SCHEMA), "every object closed, every property required");
  });

  it("treats a refusal, a max_tokens cut-off, non-JSON and off-schema JSON as no reading, never an empty one", () => {
    assert.match(String((json.parseResponse({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }) as { noReading: string }).noReading), /declined.*cyber/);
    assert.match(String((json.parseResponse({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"reports": [' }] }) as { noReading: string }).noReading), /max_tokens/);
    assert.match(String((json.parseResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "Here you go" }] }) as { noReading: string }).noReading), /not JSON/);
    assert.match(String((json.parseResponse({ stop_reason: "end_turn", content: [{ type: "text", text: '{"reports": [{"doc": 1}], "statements": []}' }] }) as { noReading: string }).noReading), /doesn't match the schema/);
    const r = lienstack(load("alta-01"), replayReader("claude-json", load("alta-12")));
    assert.notEqual(r.verdict, "pass");
  });

  it("skips thinking blocks and reads the JSON text block", () => {
    const parsed = json.parseResponse({ stop_reason: "end_turn", content: [{ type: "thinking", text: "" }, { type: "text", text: '{"reports": [], "statements": [{"doc": "s", "date": null, "original": null, "balance": {"value": 1, "doc": "s", "page": 1, "quote": "Principal Balance: $1.00"}}]}' }] });
    assert.deepEqual(parsed, { proposals: [{ doc: "s", page: 1, field: "principal balance", value: 1, quote: "Principal Balance: $1.00" }] });
  });
});

describe("reader B: native citations over one custom-content document per page", () => {
  it("sends each page as its own document with citations on, a wrapped item as one block, and no structured output", () => {
    const body = citations.buildRequest(load("alta-07").docs) as { output_config: Record<string, unknown>; messages: { content: { type: string; title?: string; citations?: { enabled: boolean }; source?: { type: string; content: { text: string }[] } }[] }[] };
    assert.ok(!("format" in body.output_config), "citations and structured outputs can't share a request");
    const docs = body.messages[0]!.content.filter((c) => c.type === "document");
    assert.ok(docs.every((d) => d.citations?.enabled === true && d.source?.type === "content"));
    const page4 = docs.find((d) => d.title === "commitment page 4")!;
    const item9 = page4.source!.content.find((b) => b.text.startsWith("9. "))!;
    assert.match(item9.text, /\(Revolving Line of Credit\)/);
    assert.match(item9.text, /Beneficiary: Bramblecrest Federal Credit Union/);
  });

  it("reads the value from the model's text and the quote from the cited block, so a repaired value still meets the gate", () => {
    const file = load("alta-02");
    const pages = citations.documentsOf(file.docs);
    const index = pages.findIndex((p) => p.doc === "commitment" && p.page === 4);
    const block = pages[index]!.blocks.findIndex((b) => b.startsWith("8. "));
    const response = {
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "commitment|item 8 recorded: " },
        { type: "text", text: "2021-03-03", citations: [{ type: "content_block_location", document_index: index, start_block_index: block, end_block_index: block + 1, cited_text: "..." }] },
        { type: "text", text: "\n" },
      ],
    };
    const parsed = citations.parseResponse(response, file.docs) as { proposals: { value: unknown; quote: string; page: number }[] };
    assert.equal(parsed.proposals[0]!.value, "2021-03-03");
    assert.match(parsed.proposals[0]!.quote, /recorded March 3, 20212022/);
    assert.equal(parsed.proposals[0]!.page, 4);
  });
});

describe("recordings", () => {
  it("are exactly what scripts/simulate.ts writes, each marked simulated", () => {
    for (const r of simulated()) {
      assert.equal(readFileSync(recordingPath(r.reader, r.file), "utf8"), render(r), `${r.reader}/${r.file}`);
      assert.equal(r.kind, "simulated");
      assert.match(r.note ?? "", /^simulated, not model output/);
    }
  });

  it("refuse to replay once the prompt, the request or the serving model has changed", () => {
    const file = load("alta-01");
    const reader = MODEL_READERS["claude-json"]!;
    const good = loadRecording("claude-json", "alta-01")!;
    assert.equal(stale(good, reader, file), null);
    assert.match(stale({ ...good, promptSha: "0".repeat(64) }, reader, file) ?? "", /record it again/);
    const edited = { ...file, docs: file.docs.map((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, text: p.text.replace("Fee Simple", "Leasehold") })) })) };
    assert.match(stale(good, reader, edited) ?? "", /request this reader builds for alta-01 has changed/);
    assert.match(stale({ ...good, response: { ...good.response, model: "claude-opus-4-8" } }, reader, file) ?? "", /fallback model is not this reader/);
    mkdirSync(join(dir, "claude-json"), { recursive: true });
    writeFileSync(join(dir, "claude-json", "alta-01.json"), JSON.stringify({ ...good, promptSha: "0".repeat(64) }));
    assert.throws(() => lienstack(file, replayReader("claude-json", file, dir)), /record it again/);
  });

  it("make a missing recording no reading, so the file can't pass", () => {
    const file = load("alta-01");
    const r = lienstack(file, replayReader("claude-citations", file, join(dir, "empty")));
    assert.equal(r.verdict, "unknown");
    assert.match(r.checks[0]!.because, /no reading: no claude-citations recording for alta-01/);
  });
});
