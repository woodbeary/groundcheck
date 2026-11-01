import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseFile, type LoanFile } from "../src/core/file.ts";
import { kindOf, lienstack, readTitle, type LienRequest, type TitleReader } from "../src/lienstack/index.ts";
import { fromProposals } from "../src/readers/proposals.ts";
import { OUT, keyOf, layoutB, render, type Generated } from "../scripts/layout-b.ts";

const generated = layoutB();
const load = (g: Generated): LoanFile<LienRequest> => parseFile<LienRequest>(g.json, render(g.json));
const ideal = (g: Generated): TitleReader => () => fromProposals(g.ideal);
const byId = (id: string) => generated.find((g) => g.id === id)!;

describe("layout B: ALTA-style commitments from a second generator", () => {
  it("the committed files and key are exactly what the generator writes", () => {
    const committed = readdirSync(OUT).filter((n) => /^alta-\d+\.json$/.test(n)).sort();
    assert.deepEqual(committed, generated.map((g) => `${g.id}.json`));
    for (const g of generated) assert.equal(readFileSync(join(OUT, `${g.id}.json`), "utf8"), render(g.json), g.id);
    assert.deepEqual((JSON.parse(readFileSync(join(OUT, "key.json"), "utf8")) as { files: unknown }).files, keyOf(generated));
  });

  for (const g of generated) {
    it(`${g.id}: a reader that proposes exactly what is printed gets the verdict the file was built for (${g.expect})`, () => {
      const r = lienstack(load(g), ideal(g));
      assert.equal(r.verdict, g.expect, `${g.note}\n${r.checks.map((c) => `${c.id} ${c.status}: ${c.because}`).join("\n")}`);
      for (const i of g.ideal.filter((x) => x.mustHold)) {
        const claim = r.claims.find((c) => c.doc === i.doc && c.field === i.field);
        assert.equal(claim?.status, "held", `${i.doc} ${i.field} must be held`);
      }
      const unexpected = r.claims.filter((c) => c.status !== "supported" && !g.ideal.some((i) => i.mustHold && i.doc === c.doc && i.field === c.field));
      assert.deepEqual(unexpected, []);
    });
  }

  it("the layout-A reference reader reads nothing in a commitment, so it can't pass one", () => {
    for (const g of generated) {
      const r = lienstack(load(g), readTitle);
      assert.equal(r.report.current, null, g.id);
      assert.notEqual(r.verdict, "pass", g.id);
    }
  });

  it("reads a commitment's standard exceptions as no recorded lien, though they mention liens", () => {
    for (const text of [
      "1. Any defect, lien, encumbrance, adverse claim, or other matter that appears for the first time in the Public Records or is created, attaches, or is disclosed between the Commitment Date and the date on which all of the Schedule B, Part I-Requirements are met.",
      "5. Taxes or special assessments that are not shown as existing liens by the Public Records.",
    ]) {
      assert.equal(kindOf(text), "other");
    }
  });

  it("won't let a Part I requirement stand for the Part II exception with the same number", () => {
    const g = byId("alta-06");
    const file = load(g);
    const partI = file.docs[0]!.pages.find((p) => /PART I - REQUIREMENTS/.test(p.text))!;
    const requirement5 = partI.text.split("\n").find((l) => l.startsWith("5. "))!;
    const borrows: TitleReader = () =>
      fromProposals(g.ideal.map((i) => (i.doc === "commitment" && i.field === "item 5 kind" ? { ...i, page: partI.n, value: "deed-of-trust", quote: requirement5 } : i)));
    const r = lienstack(file, borrows);
    assert.match(r.claims.find((c) => c.field === "item 5 kind")?.reason ?? "", /cites page 2, not page 3/);
    assert.notEqual(r.verdict, "pass");
  });

  it("reads a line of credit from the item's second line, and won't take the first line alone", () => {
    const g = byId("alta-07");
    const firstLineOnly: TitleReader = () =>
      fromProposals(g.ideal.map((i) => (i.field === "item 9 kind" ? { ...i, value: "deed-of-trust", quote: "9. A Deed of Trust and Assignment of Rents" } : i)));
    const r = lienstack(load(g), firstLineOnly);
    assert.match(r.claims.find((c) => c.field === "item 9 kind")?.reason ?? "", /only part of the item/);
    assert.equal(r.checks.find((c) => c.id === "no-senior-heloc")?.status, "unknown");
    assert.equal(lienstack(load(g), ideal(g)).checks.find((c) => c.id === "no-senior-heloc")?.status, "fail");
  });

  it("won't take the item's 'dated' day as its recording date", () => {
    const g = byId("alta-01");
    const dated: TitleReader = () => fromProposals(g.ideal.map((i) => (i.field === "item 8 recorded" ? { ...i, value: "2021-02-26", quote: "dated February 26, 2021" } : i)));
    const r = lienstack(load(g), dated);
    assert.match(r.claims.find((c) => c.field === "item 8 recorded")?.reason ?? "", /not a recording line/);
    assert.equal(r.checks.find((c) => c.id === "first-seasoned")?.status, "unknown");
  });
});

describe("section headers are printed headers, not words inside an item", () => {
  it("keeps a wrapped standard exception that mentions 'Schedule B, Part I-Requirements' as one item, in Part II", () => {
    const g = generated.find((x) => x.id === "alta-01")!;
    const file = load(g);
    const wrapped = {
      ...file,
      docs: file.docs.map((d) => ({
        ...d,
        pages: d.pages.map((p) => ({ ...p, text: p.text.replace("between the Commitment Date and the date on which all of the Schedule B, Part I-Requirements are met.", "between the Commitment Date and the date on which all of the\n   Schedule B, Part I-Requirements are met.") })),
      })),
    };
    const quote = "1. Any defect, lien, encumbrance, adverse claim, or other matter that appears for the first time in the Public Records or is created, attaches, or is disclosed between the Commitment Date and the date on which all of the Schedule B, Part I-Requirements are met.";
    const r = lienstack(wrapped, () => fromProposals(g.ideal.map((i) => (i.field === "item 1 kind" ? { ...i, quote } : i))));
    assert.equal(r.claims.find((c) => c.field === "item 1 kind")?.status, "supported");
    assert.equal(r.verdict, "pass");
  });
});
