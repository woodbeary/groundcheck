import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demo } from "../scripts/encompass-demo.ts";

describe("the Encompass demo on the doc-derived mocks", () => {
  it("runs the five beats and says on its first and last line that nothing ran live", async () => {
    const lines: string[] = [];
    await demo((l) => lines.push(l));
    const out = lines.join("\n");
    assert.match(lines[0]!, /^Live against Encompass: no\. Live against Ocrolus: no\./);
    assert.match(out, /confirmed in eFolder 6 of 6 · UNKNOWN pages 1 \(to review\) · stuck 0 · health GREEN/);
    assert.match(out, /on restart: confirmed, found by attachment ID; the hash matches; uploads sent 7/);
    assert.match(out, /a PUT answers 200 and keeps nothing: unconfirmed_never_resubmitted/);
    assert.match(out, /health RED\n\s+1 attachment\(s\) unconfirmed, waiting for a person/);
    assert.match(out, /staged 3850\.00 beside the loan's 3100\.00; nothing overwrote 3100\.00/);
    assert.match(out, /Overlay B \(fictional\) CAN'T TELL; needs lease rent: no lease captured/);
    assert.match(lines.at(-1)!, /Live against Encompass: no\./);
  });
});
