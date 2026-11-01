/**
 * Scoring a title reader through the gate, per reader and per layout:
 *
 * - field accuracy: keyed fields the gate supports at exactly the keyed value, or holds where the
 *   key says the printed text must be held;
 * - wrong: fields proposed but not right (unsupported, held when the key has a value, or
 *   supported at another value, which a coarse citation can let through);
 * - unsupported rate: proposals the gate rejected, over all proposals (where invented or
 *   misplaced values show up);
 * - held rate on must-hold keys: garbles the reader proposed and the gate held, over all of them;
 * - can't-tell rate: rule results that came back "can't tell", over all rule results;
 * - verdicts right: files whose verdict is the one the file was built for.
 */

import type { Tri } from "../core/interval.ts";
import type { LienReport } from "../lienstack/types.ts";

export interface TitleKey {
  readonly keyedBy: string;
  readonly files: Readonly<Record<string, { readonly expect: Tri; readonly fields: Readonly<Record<string, string | number | null>> }>>;
}

export interface TitleScore {
  readonly files: number;
  readonly fields: number;
  readonly correct: number;
  readonly wrong: number;
  readonly missed: number;
  readonly claims: number;
  readonly unsupported: number;
  readonly held: number;
  readonly mustHold: number;
  readonly mustHoldHeld: number;
  readonly checks: number;
  readonly cantTell: number;
  readonly verdictsRight: number;
}

function same(a: unknown, b: string | number): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.round(a * 100) === Math.round(b * 100) : a === b;
}

export function scoreTitle(reports: readonly LienReport[], key: TitleKey): TitleScore {
  let fields = 0;
  let correct = 0;
  let missed = 0;
  let mustHold = 0;
  let mustHoldHeld = 0;
  let verdictsRight = 0;
  for (const report of reports) {
    const keyed = key.files[report.file];
    if (!keyed) throw new Error(`no key for ${report.file}`);
    if (report.verdict === keyed.expect) verdictsRight += 1;
    for (const [slot, expected] of Object.entries(keyed.fields)) {
      fields += 1;
      const [doc, field] = slot.split("|") as [string, string];
      const proposals = report.claims.filter((c) => (c.about ?? c.doc) === doc && c.field === field);
      if (expected === null) mustHold += 1;
      if (proposals.length === 0) missed += 1;
      else if (proposals.some((c) => (expected === null ? c.status === "held" : c.status === "supported" && same(c.value, expected)))) {
        correct += 1;
        if (expected === null) mustHoldHeld += 1;
      }
    }
  }
  const claims = reports.flatMap((r) => r.claims);
  const checks = reports.flatMap((r) => r.checks);
  return {
    files: reports.length,
    fields,
    correct,
    wrong: fields - correct - missed,
    missed,
    claims: claims.length,
    unsupported: claims.filter((c) => c.status === "unsupported").length,
    held: claims.filter((c) => c.status === "held").length,
    mustHold,
    mustHoldHeld,
    checks: checks.length,
    cantTell: checks.filter((c) => c.status === "unknown").length,
    verdictsRight,
  };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

export function describeScore(s: TitleScore): string[] {
  return [
    `  fields keyed ${s.fields}  correct ${s.correct}  wrong ${s.wrong}  missed ${s.missed}   accuracy ${pct(s.correct, s.fields)}`,
    `  proposals ${s.claims}  unsupported ${s.unsupported} (${pct(s.unsupported, s.claims)})  held ${s.held}   must-hold keys held ${s.mustHoldHeld} of ${s.mustHold}`,
    `  rule results can't tell ${s.cantTell} of ${s.checks} (${pct(s.cantTell, s.checks)})   verdicts as built ${s.verdictsRight} of ${s.files}`,
  ];
}

/** What may not get worse between a pinned baseline and a run: counts, so one new unsupported value fails. */
export function regressions(now: TitleScore, pinned: TitleScore): string[] {
  const out: string[] = [];
  if (now.fields !== pinned.fields || now.files !== pinned.files) out.push(`keyed set changed: ${now.files} files and ${now.fields} fields, pinned ${pinned.files} and ${pinned.fields}; pin the baseline again on purpose`);
  if (now.correct < pinned.correct) out.push(`correct fell from ${pinned.correct} to ${now.correct}`);
  if (now.wrong > pinned.wrong) out.push(`wrong rose from ${pinned.wrong} to ${now.wrong}`);
  if (now.unsupported > pinned.unsupported) out.push(`unsupported rose from ${pinned.unsupported} to ${now.unsupported}`);
  if (now.mustHoldHeld < pinned.mustHoldHeld) out.push(`must-hold keys held fell from ${pinned.mustHoldHeld} to ${now.mustHoldHeld}`);
  if (now.cantTell > pinned.cantTell) out.push(`can't tell rose from ${pinned.cantTell} to ${now.cantTell}`);
  if (now.verdictsRight < pinned.verdictsRight) out.push(`verdicts as built fell from ${pinned.verdictsRight} to ${now.verdictsRight}`);
  return out;
}
