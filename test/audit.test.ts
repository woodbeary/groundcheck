import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendRun, readAudit, resolveHeld, verifyAudit } from "../src/core/audit.ts";
import { sha256 } from "../src/core/file.ts";
import { lienstack, type LienRequest } from "../src/lienstack/index.ts";
import { EXAMPLES, example } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "groundcheck-audit-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reference = { reader: "reference", version: "0.1.0", promptSha: null };

describe("the provenance log", () => {
  it("writes one row per gated claim with the file hash, the quote, the reader and the gate's decision", () => {
    const log = join(dir, "one.jsonl");
    const r = lienstack(example<LienRequest>("title", "title-03"));
    appendRun(log, { check: "lienstack", ...r }, reference, "2026-11-01T00:00:00Z");
    const rows = readAudit(log);
    assert.equal(rows.length, r.claims.length);
    const held = rows.find((row) => row.field === "item 3 amount")!;
    assert.equal(held.status, "held");
    assert.equal(held.sha256, r.sha256);
    assert.equal(held.quote, "amount of $318400,000.00,");
    assert.match(held.reason ?? "", /digits run together/);
    assert.equal(held.decidedBy, null);
    assert.ok(rows.every((row) => row.reader === "reference" && row.promptSha === null));
  });

  it("only appends: a second run leaves every earlier line byte for byte", () => {
    const log = join(dir, "two.jsonl");
    appendRun(log, { check: "lienstack", ...lienstack(example<LienRequest>("title", "title-01")) }, reference);
    const before = readFileSync(log, "utf8");
    appendRun(log, { check: "lienstack", ...lienstack(example<LienRequest>("title", "title-02")) }, reference);
    assert.ok(readFileSync(log, "utf8").startsWith(before));
    assert.equal(verifyAudit(log), null);
  });

  it("no longer verifies once a line is edited, dropped or reordered", () => {
    const log = join(dir, "three.jsonl");
    appendRun(log, { check: "lienstack", ...lienstack(example<LienRequest>("title", "title-02")) }, reference);
    const good = readFileSync(log, "utf8").split("\n").filter(Boolean);
    writeFileSync(log, [good[0], good[1]!.replace('"supported"', '"held"'), ...good.slice(2)].join("\n") + "\n");
    assert.equal(verifyAudit(log)?.line, 3);
    writeFileSync(log, [good[0], ...good.slice(2)].join("\n") + "\n");
    assert.equal(verifyAudit(log)?.line, 2);
    writeFileSync(log, [good[1], good[0], ...good.slice(2)].join("\n") + "\n");
    assert.equal(verifyAudit(log)?.line, 1);
  });

  it("records a person's resolution of a held value as a new row with their name, never an edit", () => {
    const log = join(dir, "four.jsonl");
    appendRun(log, { check: "lienstack", ...lienstack(example<LienRequest>("title", "title-03")) }, reference);
    const rows = readAudit(log);
    const heldLine = rows.findIndex((row) => row.status === "held") + 1;
    const before = readFileSync(log, "utf8");
    const resolved = resolveHeld(log, heldLine, { decidedBy: "Title officer (synthetic)", value: 400_000, reason: "recorded deed of trust read at the county" });
    assert.ok(readFileSync(log, "utf8").startsWith(before));
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.decidedBy, "Title officer (synthetic)");
    assert.equal(resolved.resolves, sha256(before.split("\n")[heldLine - 1]!));
    assert.equal(verifyAudit(log), null);
    assert.throws(() => resolveHeld(log, heldLine, { decidedBy: "someone", value: 1, reason: "again" }), /already resolved/);
    assert.throws(() => resolveHeld(log, 1, { decidedBy: "someone", value: 1, reason: "x" }), /only a held value/);
    assert.throws(() => resolveHeld(log, heldLine, { decidedBy: " ", value: 1, reason: "x" }), /name of the person/);
  });

  it("is written by the CLI with --audit", () => {
    const log = join(dir, "cli.jsonl");
    const root = new URL("../", import.meta.url).pathname;
    const r = spawnSync(process.execPath, ["src/cli.ts", "dscr", join(EXAMPLES, "dscr", "dscr-03.json"), "--audit", log], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const rows = readAudit(log);
    assert.ok(rows.length > 10);
    assert.ok(rows.some((row) => row.check === "dscr-check" && row.status === "held"));
  });
});
