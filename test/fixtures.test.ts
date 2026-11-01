import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXAMPLES } from "./helpers.ts";

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const ACCOUNT = /\b\d{9,}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

describe("example files carry no real-looking personal data", () => {
  for (const kind of ["title", "dscr"]) {
    for (const name of readdirSync(join(EXAMPLES, kind)).filter((n) => n.endsWith(".json"))) {
      it(`${kind}/${name}`, () => {
        const text = readFileSync(join(EXAMPLES, kind, name), "utf8");
        assert.doesNotMatch(text, SSN, "SSN-shaped string");
        assert.doesNotMatch(text, ACCOUNT, "nine or more digits in a row");
        assert.doesNotMatch(text, EMAIL, "email address");
        assert.doesNotMatch(text, PHONE, "phone number");
        if (/^(title|dscr)-\d+\.json$/.test(name)) assert.equal(JSON.parse(text).synthetic, true);
      });
    }
  }
});
