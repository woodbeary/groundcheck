import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, root), "utf8");

describe("the package ships as groundcheck", () => {
  it("names the package and the README groundcheck, with lienstack and dscr-check as its two checks", () => {
    assert.equal((JSON.parse(text("package.json")) as { name: string }).name, "groundcheck");
    const readme = text("README.md");
    assert.match(readme, /^# groundcheck\n/);
    assert.match(readme, /\*\*lienstack\*\*/);
    assert.match(readme, /\*\*dscr-check\*\*/);
  });

  it("dates the held merged-edit cells and the blocked DSCR grid to October 3, 2026, when the HELOC engine recorded them", () => {
    const readme = text("README.md");
    assert.match(readme, /\*\*October 3, 2026\.\*\* Transcribing/);
    assert.doesNotMatch(readme, /October 4, 2026/);
  });

  it("has CI run the eval ratchet and the Encompass demo on Node 22 and 24", () => {
    const ci = text(".github/workflows/ci.yml");
    assert.match(ci, /node: \["22", "24"\]/);
    assert.match(ci, /pnpm -s eval/);
    assert.match(ci, /pnpm -s demo:encompass/);
    assert.match(ci, /--as-of 2026-12-15/);
  });

  it("says on its first screen that nothing has run live, and that the model recordings are simulated", () => {
    const readme = text("README.md");
    const top = readme.slice(0, readme.indexOf("## Why I built this"));
    assert.match(top, /\| Live against Encompass \| \*\*no\*\*/);
    assert.match(top, /\| Live against Ocrolus \| \*\*no\*\*/);
    assert.match(top, /\| Live model runs recorded \| \*\*none\*\*: the model readers' recordings in `recordings\/` are simulated, not model output/);
    assert.match(top, /\| Outside keys \| \*\*none yet\*\*/);
  });

  it("prints the eval table from eval/baseline.json, with the simulated rows marked", () => {
    const readme = text("README.md");
    const pinned = JSON.parse(text("eval/baseline.json")) as { entries: Record<string, { fields: number; correct: number; wrong: number; missed: number; unsupported: number; claims: number; mustHoldHeld: number; mustHold: number; cantTell: number; checks: number; responses: string }> };
    const rows: Record<string, RegExp> = {
      "reference@title-a": /^\| reference on A \(circular: written for these files\) \|/m,
      "reference@title-b": /^\| reference on B \|/m,
      "claude-json@title-b": /^\| claude-json on B, \*\*simulated responses\*\* \|/m,
      "claude-citations@title-b": /^\| claude-citations on B, \*\*simulated responses\*\* \|/m,
    };
    for (const [pair, head] of Object.entries(rows)) {
      const e = pinned.entries[pair]!;
      const line = readme.split("\n").find((l) => head.test(l));
      assert.ok(line, pair);
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean).slice(1);
      assert.deepEqual(cells, [String(e.fields), String(e.correct), String(e.wrong), String(e.missed), `${e.unsupported} of ${e.claims}`, `${e.mustHoldHeld} of ${e.mustHold}`, `${e.cantTell} of ${e.checks}`], pair);
      if (e.responses.includes("simulated")) assert.match(line, /simulated responses/);
    }
  });
});
