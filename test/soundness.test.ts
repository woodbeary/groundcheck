import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allPages, withoutPages, type LoanFile } from "../src/core/file.ts";
import type { Interval, Tri } from "../src/core/interval.ts";
import { dscrCheck, type DscrRequest } from "../src/dscr/index.ts";
import { lienstack, type LienRequest } from "../src/lienstack/index.ts";
import { examples } from "./helpers.ts";

/** Losing information may turn a result into "can't tell". It may never turn it into anything else. */
function onlyWidens(before: Tri, after: Tri): boolean {
  return after === before || after === "unknown";
}

function contains(outer: Interval, inner: Interval): boolean {
  return outer.lo <= inner.lo && outer.hi >= inner.hi;
}

function removals<R>(file: LoanFile<R>): { label: string; file: LoanFile<R> }[] {
  const pages = allPages(file as LoanFile<unknown>);
  const singles = pages.map((p) => [p]);
  const pairs = pages.flatMap((p, i) => pages.slice(i + 1).map((q) => [p, q]));
  return [...singles, ...pairs].map((gone) => ({ label: gone.map((g) => `${g.doc} p.${g.n}`).join(" + "), file: withoutPages(file, gone) }));
}

describe("soundness: a missing page can only widen", () => {
  for (const file of examples<LienRequest>("title")) {
    it(`lienstack ${file.id}: no check, verdict or range gets more decided when one or two pages go missing`, () => {
      const full = lienstack(file);
      for (const { label, file: less } of removals(file)) {
        const r = lienstack(less);
        for (const c of full.checks) {
          const after = r.checks.find((x) => x.id === c.id)!.status;
          assert.ok(onlyWidens(c.status, after), `${file.id} without ${label}: ${c.id} went ${c.status} -> ${after}`);
        }
        assert.ok(onlyWidens(full.verdict, r.verdict), `${file.id} without ${label}: verdict ${full.verdict} -> ${r.verdict}`);
        assert.ok(contains(r.cltv, full.cltv), `${file.id} without ${label}: CLTV narrowed`);
        assert.ok(full.heloc.otherLoan === r.heloc.otherLoan || r.heloc.otherLoan === "unknown", `${file.id} without ${label}: otherLoan`);
        assert.ok(contains(r.heloc.otherBalance, full.heloc.otherBalance), `${file.id} without ${label}: otherBalance narrowed`);
        assert.ok(contains(r.heloc.balance, full.heloc.balance), `${file.id} without ${label}: balance narrowed`);
      }
    });
  }

  for (const file of examples<DscrRequest>("dscr")) {
    it(`dscr-check ${file.id}: no overlay result gets more decided, and every range only widens`, () => {
      const full = dscrCheck(file);
      for (const { label, file: less } of removals(file)) {
        const r = dscrCheck(less);
        for (const o of full.overlays) {
          const after = r.overlays.find((x) => x.overlay.id === o.overlay.id)!.status;
          assert.ok(onlyWidens(o.status, after), `${file.id} without ${label}: ${o.overlay.id} went ${o.status} -> ${after}`);
        }
        assert.ok(contains(r.dscr, full.dscr), `${file.id} without ${label}: DSCR narrowed`);
        for (const p of full.parts) assert.ok(contains(r.parts.find((x) => x.name === p.name)!.value, p.value), `${file.id} without ${label}: ${p.name} narrowed`);
      }
    });
  }
});
