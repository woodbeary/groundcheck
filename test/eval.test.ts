import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readDscr, type DscrReader, type DscrRequest } from "../src/dscr/index.ts";
import { replay, scoreReader, type BadOutput, type HandKeyed } from "../src/dscr/eval.ts";
import { EXAMPLES, example, examples } from "./helpers.ts";

const json = <T>(name: string): T => JSON.parse(readFileSync(join(EXAMPLES, "dscr", name), "utf8")) as T;
const keyed = json<HandKeyed>("hand-keyed.json");
const baseline = json<{ accuracy: number; unsupportedRate: number }>("eval-baseline.json");
const bad = json<BadOutput[]>("bad-outputs.json");
const files = examples<DscrRequest>("dscr");

/** A stand-in for a reader that tidies garbles and fills gaps: the failure the gate exists for. */
const careless: DscrReader = (docs, routed) => {
  const reading = readDscr(docs, routed);
  const market = reading.appraisals[0]?.marketRent;
  return {
    ...reading,
    leases: reading.leases.length > 0 || !market ? reading.leases : [{ doc: "rent-schedule", rent: { ...market, field: "lease rent" } }],
    taxBills: reading.taxBills.map((t) => (t.annual ? { ...t, annual: { ...t.annual, value: Math.round(t.annual.value) === t.annual.value ? t.annual.value : 5400 } } : t)),
    notes: reading.notes.map((n) => (n.payment && n.principal ? { ...n, payment: { ...n.payment, value: 2425.39 } } : n)),
  };
};

describe("reader eval against the hand-keyed set", () => {
  it("every keyed file exists and every example file is keyed", () => {
    assert.deepEqual(Object.keys(keyed).sort(), files.map((f) => f.id));
  });

  it("the reference reader holds the bar recorded in eval-baseline.json", () => {
    const s = scoreReader(files, keyed);
    assert.ok(s.accuracy >= baseline.accuracy, `accuracy ${s.accuracy} fell below ${baseline.accuracy}`);
    assert.ok(s.unsupportedRate <= baseline.unsupportedRate, `unsupported rate ${s.unsupportedRate} rose above ${baseline.unsupportedRate}`);
  });

  it("a reader that repairs and fills in fails the same bar", () => {
    const s = scoreReader(files, keyed, { reader: careless });
    assert.ok(s.accuracy < baseline.accuracy || s.unsupportedRate > baseline.unsupportedRate);
    assert.ok(s.unsupported >= 1);
    assert.ok(s.wrong >= 1);
  });
});

describe("golden set: bad outputs a reviewer flagged stay rejected", () => {
  for (const b of bad) {
    it(`${b.file}: ${b.note}`, () => {
      assert.equal(replay(example<DscrRequest>("dscr", b.file), b), b.expect);
    });
  }
});
