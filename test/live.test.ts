import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { parseFile, type LoanFile } from "../src/core/file.ts";
import { recordLive, sdkSender } from "../src/readers/live.ts";
import { MODEL_READERS, loadRecording, stale } from "../src/readers/recordings.ts";
import { layoutB, render } from "../scripts/layout-b.ts";

const load = (id: string): LoanFile<unknown> => {
  const g = layoutB().find((x) => x.id === id)!;
  return parseFile(g.json, render(g.json));
};

/** A local stand-in for the Messages endpoint: it keeps what it was sent and answers with a canned message. */
async function standIn(answer: (body: Record<string, unknown>) => unknown): Promise<{ url: string; seen: { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[]; close: () => void }> {
  const seen: { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

describe("recording live through the Anthropic SDK (against a local stand-in, never the API)", () => {
  it("sends exactly the request the reader built, wire page withheld, and saves a replayable live recording", async () => {
    const file = load("alta-10");
    const canned = loadRecording("claude-json", "alta-10")!.response;
    const api = await standIn(() => canned);
    try {
      const recording = await recordLive("claude-json", file, sdkSender({ baseURL: api.url, apiKey: "test-only-not-a-key" }), "2026-11-01T00:00:00Z");
      assert.equal(api.seen.length, 1);
      assert.equal(api.seen[0]!.path, "/v1/messages");
      assert.deepEqual(api.seen[0]!.body, MODEL_READERS["claude-json"]!.build(file.docs));
      assert.ok(!JSON.stringify(api.seen[0]!.body).includes("CANARY-WIRE-7F3E"));
      assert.equal(recording.kind, "live");
      assert.equal(stale(recording, MODEL_READERS["claude-json"]!, file), null);
    } finally {
      api.close();
    }
  });

  it("won't save a response from a model other than the one it asked", async () => {
    const file = load("alta-01");
    const canned = loadRecording("claude-citations", "alta-01")!.response;
    const api = await standIn(() => ({ ...canned, model: "claude-opus-4-8" }));
    try {
      await assert.rejects(recordLive("claude-citations", file, sdkSender({ baseURL: api.url, apiKey: "test-only-not-a-key" })), /claude-opus-4-8 answered, not claude-opus-5-5; not saved/);
    } finally {
      api.close();
    }
  });
});
