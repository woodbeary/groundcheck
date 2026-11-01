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
});
