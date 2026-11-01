import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, it } from "node:test";
import { parseFile } from "../src/core/file.ts";
import { EXAMPLES } from "./helpers.ts";

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const ACCOUNT = /\b\d{9,}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

/** Every JSON fixture in the repository: examples, recorded reader responses and doc-derived mocks. */
const FIXTURE_DIRS = ["examples", "recordings", "fixtures"].map((d) => new URL(`../${d}/`, import.meta.url).pathname);

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsonFiles(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : []));
}

describe("fixtures carry no real-looking personal data", () => {
  const all = FIXTURE_DIRS.flatMap(jsonFiles);
  it("finds the fixtures", () => assert.ok(all.some((p) => p.includes("title-b"))));
  for (const path of all) {
    it(relative(EXAMPLES, path), () => {
      const text = readFileSync(path, "utf8");
      assert.doesNotMatch(text, SSN, "SSN-shaped string");
      assert.doesNotMatch(text, ACCOUNT, "nine or more digits in a row");
      assert.doesNotMatch(text, EMAIL, "email address");
      assert.doesNotMatch(text, PHONE, "phone number");
      if (path.startsWith(EXAMPLES) && /^(title|dscr|alta)-\d+\.json$/.test(basename(path))) assert.equal(JSON.parse(text).synthetic, true);
    });
  }
});

describe("the loader", () => {
  it("refuses a file not marked synthetic", () => {
    const real = { id: "x", synthetic: false, request: {}, docs: [{ id: "d", pages: [{ n: 1, lines: ["text"] }] }] };
    assert.throws(() => parseFile(real), /only synthetic files/);
    assert.throws(() => parseFile({ id: "x" }), /not a loan file/);
  });
});
