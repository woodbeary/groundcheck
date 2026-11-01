import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BASELINE, PAIRS, layoutFiles, layoutKey, pairId, runTitle, type Pinned } from "../src/eval/run.ts";
import { regressions, scoreTitle } from "../src/eval/title.ts";
import { lienstack } from "../src/lienstack/index.ts";
import { fromProposals } from "../src/readers/proposals.ts";
import { layoutB } from "../scripts/layout-b.ts";

const pinned = JSON.parse(readFileSync(BASELINE, "utf8")) as Pinned;

describe("title reader eval, per reader and layout", () => {
  it("keys every file of both layouts", () => {
    for (const layout of ["title-a", "title-b"] as const) assert.deepEqual(Object.keys(layoutKey(layout).files).sort(), layoutFiles(layout).map((f) => f.id));
  });

  for (const p of PAIRS) {
    it(`${pairId(p.reader, p.layout)} is no worse than eval/baseline.json on any count`, () => {
      const before = pinned.entries[pairId(p.reader, p.layout)];
      assert.ok(before, "pinned");
      assert.deepEqual(regressions(runTitle(p.reader, p.layout).score, before), []);
    });
  }

  it("fails a reader that tidies garbles, even though its accuracy elsewhere goes up", () => {
    const generated = layoutB();
    const files = layoutFiles("title-b");
    const tidy = (q: string) => q.replace("20212022", "2021").replace("$371,218.40*", "$371,218.40").replace("$9,877.00$10,412.00", "$10,412.00");
    const reports = files.map((f) => lienstack(f, () => fromProposals(generated.find((g) => g.id === f.id)!.ideal.map((i) => ({ ...i, quote: i.mustHold ? tidy(i.quote) : i.quote })))));
    const score = scoreTitle(reports, layoutKey("title-b"));
    const before = pinned.entries[pairId("claude-json", "title-b")]!;
    assert.ok(score.correct > before.correct);
    assert.equal(score.mustHoldHeld, 0);
    assert.ok(regressions(score, before).some((r) => /must-hold keys held fell/.test(r)));
  });

  it("counts one new unsupported value as a regression", () => {
    const before = pinned.entries[pairId("claude-citations", "title-b")]!;
    assert.deepEqual(regressions({ ...before, unsupported: before.unsupported + 1 }, before), [`unsupported rose from ${before.unsupported} to ${before.unsupported + 1}`]);
  });

  it("scores the layout-A reference reader 0 on what it can't read in layout B, instead of guessing", () => {
    const r = runTitle("reference", "title-b").score;
    assert.equal(r.cantTell, r.checks);
    assert.equal(r.unsupported, 0);
  });
});
