import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../src/core/file.ts";
import { EXAMPLES } from "./helpers.ts";

const ROOT = new URL("../", import.meta.url).pathname;

function cli(...args: string[]): { out: string; err: string; code: number | null } {
  const r = spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: ROOT, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const title01 = join(EXAMPLES, "title", "title-01.json");
const dscr02 = join(EXAMPLES, "dscr", "dscr-02.json");

describe("the CLI", () => {
  it("judges a file on the day --as-of names, so the date rule can be shown live", () => {
    const today = cli("lienstack", title01);
    assert.match(today.out, /verdict: PASS/);
    const later = cli("lienstack", title01, "--as-of", "2026-12-15");
    assert.match(later.out, /as of 2026-12-15/);
    assert.match(later.out, /"prelim" is 67 days old on 2026-12-15; the policy allows 60/);
    assert.match(later.out, /verdict: CAN'T TELL/);
    assert.doesNotMatch(later.out, /^\s+PASS/m);
  });

  it("refuses an --as-of that isn't a real day instead of guessing one", () => {
    const r = cli("lienstack", title01, "--as-of", "2026-02-30");
    assert.equal(r.code, 2);
    assert.match(r.err, /--as-of needs a real day/);
    assert.equal(r.out, "");
  });

  it("prints the input file's SHA-256 in every report", () => {
    for (const [command, path] of [["lienstack", title01], ["dscr", dscr02]] as const) {
      const expected = sha256(readFileSync(path, "utf8"));
      assert.match(cli(command, path).out, new RegExp(`^file sha256 ${expected}$`, "m"), command);
    }
  });

  it("prints a report as JSON with --json, spelling out an unbounded end", () => {
    const r = JSON.parse(cli("dscr", dscr02, "--json").out) as { file: string; sha256: string; rent: { lo: number; hi: number }; dscr: { hi: unknown }; overlays: { status: string }[] };
    assert.equal(r.file, "dscr-02");
    assert.equal(r.sha256, sha256(readFileSync(dscr02, "utf8")));
    assert.deepEqual(r.rent, { lo: 0, hi: 3900 });
    assert.deepEqual(r.overlays.map((o) => o.status), ["unknown", "unknown"]);
    const open = JSON.parse(cli("lienstack", join(EXAMPLES, "title", "title-04.json"), "--json").out) as { cltv: { hi: unknown } };
    assert.equal(open.cltv.hi, "unbounded");
  });
});
