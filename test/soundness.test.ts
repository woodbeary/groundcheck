import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Doc } from "../src/core/evidence.ts";
import { allPages, parseFile, withoutPages, type LoanFile } from "../src/core/file.ts";
import type { Interval, Tri } from "../src/core/interval.ts";
import { dscrCheck, type DscrRequest } from "../src/dscr/index.ts";
import { lienstack, type LienReport, type LienRequest } from "../src/lienstack/index.ts";
import { fromProposals } from "../src/readers/proposals.ts";
import { layoutB, render } from "../scripts/layout-b.ts";
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

/**
 * Merged-edit residue in place of one printed amount: the old and new values run together, the way
 * tracked changes print when a guide is saved badly ("$318400,000.00", "7%7.125%").
 */
function residue(token: string): string {
  if (token.endsWith("%")) return `${token.slice(0, 1)}%${token}`;
  const comma = token.indexOf(",");
  return comma > 0 ? `$318${token.slice(1)}` : `${token}${token}`;
}

/** One variant per printed amount and percent, each with only that token garbled. */
function garbled<R>(file: LoanFile<R>): { label: string; file: LoanFile<R> }[] {
  return file.docs.flatMap((doc) =>
    doc.pages.flatMap((page) =>
      [...page.text.matchAll(/\$\d[\d,]*(?:\.\d{2})?|\b\d+(?:\.\d+)?%/g)].map((m) => {
        const text = page.text.slice(0, m.index) + residue(m[0]) + page.text.slice(m.index + m[0].length);
        const docs = file.docs.map((d) => (d.id !== doc.id ? d : { ...d, pages: d.pages.map((p) => (p.n === page.n ? { ...p, text } : p)) }));
        return { label: `${doc.id} p.${page.n} '${m[0]}' -> '${residue(m[0])}'`, file: { ...file, docs } };
      }),
    ),
  );
}

describe("soundness: merged-edit residue in any amount can only widen", () => {
  for (const file of examples<LienRequest>("title")) {
    it(`lienstack ${file.id}`, () => {
      const full = lienstack(file);
      const variants = garbled(file);
      assert.ok(variants.length > 0);
      for (const { label, file: worse } of variants) {
        const r = lienstack(worse);
        for (const c of full.checks) {
          const after = r.checks.find((x) => x.id === c.id)!.status;
          assert.ok(onlyWidens(c.status, after), `${file.id} with ${label}: ${c.id} went ${c.status} -> ${after}`);
        }
        assert.ok(onlyWidens(full.verdict, r.verdict), `${file.id} with ${label}: verdict ${full.verdict} -> ${r.verdict}`);
        assert.ok(contains(r.cltv, full.cltv), `${file.id} with ${label}: CLTV narrowed`);
        assert.ok(contains(r.heloc.balance, full.heloc.balance) && contains(r.heloc.otherBalance, full.heloc.otherBalance), `${file.id} with ${label}: a HELOC balance narrowed`);
      }
    });
  }

  for (const file of examples<DscrRequest>("dscr")) {
    it(`dscr-check ${file.id}`, () => {
      const full = dscrCheck(file);
      for (const { label, file: worse } of garbled(file)) {
        const r = dscrCheck(worse);
        for (const o of full.overlays) {
          const after = r.overlays.find((x) => x.overlay.id === o.overlay.id)!.status;
          assert.ok(onlyWidens(o.status, after), `${file.id} with ${label}: ${o.overlay.id} went ${o.status} -> ${after}`);
        }
        assert.ok(contains(r.dscr, full.dscr), `${file.id} with ${label}: DSCR narrowed`);
        for (const p of full.parts) assert.ok(contains(r.parts.find((x) => x.name === p.name)!.value, p.value), `${file.id} with ${label}: ${p.name} narrowed`);
      }
    });
  }
});

/** What a title result is, leaving out which reports it names as superseded. */
function result(r: LienReport): unknown {
  return {
    checks: r.checks,
    verdict: r.verdict,
    cltv: r.cltv,
    heloc: r.heloc,
    conditions: r.conditions,
    liens: [...r.liens].sort((a, b) => a.item - b.item),
    problems: [...r.problems].map((p) => JSON.stringify(p)).sort(),
  };
}

const REPORT_HEAD = /PRELIMINARY REPORT|OWNERSHIP AND ENCUMBRANCE REPORT/;

/** The file with a copy of its current report added, effective a year earlier, as if an old one were also in the file. */
function withOlderReport(file: LoanFile<LienRequest>, current: string): LoanFile<LienRequest> {
  const report = file.docs.find((d) => d.id === current)!;
  const top = Math.max(...file.docs.flatMap((d) => d.pages.map((p) => p.n)));
  const older: Doc = {
    id: `${current}-older`,
    pages: report.pages.map((p, i) => ({ n: top + 1 + i, text: p.text.replace(/(Effective Date: \w+ \d{1,2}, )(\d{4})/, (_m, head: string, year: string) => `${head}${Number(year) - 1}`) })),
  };
  return { ...file, docs: [...file.docs, older] };
}

describe("soundness: an older report added to the file never changes a result", () => {
  for (const file of examples<LienRequest>("title")) {
    it(`lienstack ${file.id}`, () => {
      const full = lienstack(file);
      const current = full.report.current;
      if (current === null) return;
      assert.ok(file.docs.find((d) => d.id === current)!.pages.some((p) => REPORT_HEAD.test(p.text)));
      const r = lienstack(withOlderReport(file, current));
      assert.equal(r.report.current, current);
      assert.ok(r.report.superseded.includes(`${current}-older`));
      assert.deepEqual(result(r), result(full));
    });
  }
});

/** Each Schedule B page with its numbered items printed in reverse order; headers and footers stay put. */
function reversedItems(file: LoanFile<LienRequest>): LoanFile<LienRequest> {
  const docs = file.docs.map((d) => ({
    ...d,
    pages: d.pages.map((p) => {
      if (!/SCHEDULE B/.test(p.text)) return p;
      const lines = p.text.split("\n");
      const first = lines.findIndex((l) => /^\s*\d{1,2}\.\s/.test(l));
      if (first < 0) return p;
      const end = lines.findIndex((l, i) => i > first && /^\s*(?:END OF SCHEDULE B|Page\s+\d+\s+of\s+\d+)/i.test(l));
      const body = lines.slice(first, end < 0 ? lines.length : end);
      const items: string[][] = [];
      for (const line of body) (/^\s*\d{1,2}\.\s/.test(line) || items.length === 0 ? items.push([line]) : items[items.length - 1]!.push(line));
      return { ...p, text: [...lines.slice(0, first), ...items.reverse().flat(), ...(end < 0 ? [] : lines.slice(end))].join("\n") };
    }),
  }));
  return { ...file, docs };
}

describe("soundness: the order Schedule B items are printed in changes nothing", () => {
  for (const file of examples<LienRequest>("title")) {
    it(`lienstack ${file.id}`, () => {
      const shuffled = reversedItems(file);
      assert.notDeepEqual(shuffled.docs, file.docs);
      assert.deepEqual(result(lienstack(shuffled)), result(lienstack(file)));
    });
  }
});

/**
 * Layout B through a reader that proposes exactly what each commitment prints (the generator's
 * ideal proposals), since the layout-A reference reader reads nothing there. Losing pages or
 * garbling one amount may only widen what that reader's proposals decide.
 */
describe("soundness on layout B, with a reader that proposes what is printed", () => {
  for (const g of layoutB()) {
    it(`lienstack ${g.id}: no page or pair of pages lost, and no amount garbled, makes a result more decided`, () => {
      const file = parseFile<LienRequest>(g.json, render(g.json));
      const reader = () => fromProposals(g.ideal);
      const full = lienstack(file, reader);
      for (const { label, file: worse } of [...removals(file).map((v) => ({ ...v, label: `without ${v.label}` })), ...garbled(file).map((v) => ({ ...v, label: `with ${v.label}` }))]) {
        const r = lienstack(worse, reader);
        for (const c of full.checks) {
          const after = r.checks.find((x) => x.id === c.id)!.status;
          assert.ok(onlyWidens(c.status, after), `${g.id} ${label}: ${c.id} went ${c.status} -> ${after}`);
        }
        assert.ok(onlyWidens(full.verdict, r.verdict), `${g.id} ${label}: verdict ${full.verdict} -> ${r.verdict}`);
        assert.ok(contains(r.cltv, full.cltv), `${g.id} ${label}: CLTV narrowed`);
        assert.ok(full.heloc.otherLoan === r.heloc.otherLoan || r.heloc.otherLoan === "unknown", `${g.id} ${label}: otherLoan`);
        assert.ok(contains(r.heloc.balance, full.heloc.balance) && contains(r.heloc.otherBalance, full.heloc.otherBalance), `${g.id} ${label}: a HELOC balance narrowed`);
      }
    });
  }
});
