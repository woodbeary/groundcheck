/**
 * Two ways to grade a reader against labels it didn't write.
 *
 * - A hand-keyed set: for each synthetic file, the value a person keyed from the printed page for
 *   every field, or null where the printed text can't be read as one value and must come back
 *   held. Accuracy counts a field right only when the gate supports exactly that value (or holds
 *   it, when the key says held). The unsupported rate counts proposals the gate rejected, which
 *   is where invented values show up.
 * - A golden set of bad outputs: each proposal a reviewer flagged, replayed through the gate,
 *   which must keep rejecting it. Flagging a bad output adds a regression test.
 */

import type { Claim } from "../core/evidence.ts";
import type { LoanFile } from "../core/file.ts";
import { dscrCheck, type DscrOptions } from "./index.ts";
import type { DscrReader, DscrReading, DscrReport, DscrRequest, GatedClaim } from "./types.ts";

/** file id → field → the value a person keyed, or null for "must be held". */
export type HandKeyed = Readonly<Record<string, Readonly<Record<string, number | string | null>>>>;

export interface Score {
  readonly fields: number;
  readonly correct: number;
  readonly missed: number;
  readonly wrong: number;
  readonly claims: number;
  readonly held: number;
  readonly unsupported: number;
  readonly accuracy: number;
  readonly unsupportedRate: number;
  readonly heldRate: number;
}

function same(a: unknown, b: number | string): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.round(a * 100) === Math.round(b * 100) : a === b;
}

export function score(reports: readonly DscrReport[], keyed: HandKeyed): Score {
  let fields = 0;
  let correct = 0;
  let missed = 0;
  for (const report of reports) {
    for (const [field, expected] of Object.entries(keyed[report.file] ?? {})) {
      fields += 1;
      const proposals = report.claims.filter((c) => c.field === field);
      if (proposals.length === 0) missed += 1;
      else if (proposals.some((c) => (expected === null ? c.status === "held" : c.status === "supported" && same(c.value, expected)))) correct += 1;
    }
  }
  const claims: GatedClaim[] = reports.flatMap((r) => [...r.claims]);
  const held = claims.filter((c) => c.status === "held").length;
  const unsupported = claims.filter((c) => c.status === "unsupported").length;
  return {
    fields,
    correct,
    missed,
    wrong: fields - correct - missed,
    claims: claims.length,
    held,
    unsupported,
    accuracy: fields === 0 ? 0 : correct / fields,
    unsupportedRate: claims.length === 0 ? 0 : unsupported / claims.length,
    heldRate: claims.length === 0 ? 0 : held / claims.length,
  };
}

export function scoreReader(files: readonly LoanFile<DscrRequest>[], keyed: HandKeyed, options: DscrOptions = {}): Score {
  return score(files.map((f) => dscrCheck(f, options)), keyed);
}

export interface BadOutput {
  readonly file: string;
  readonly note: string;
  readonly claim: Claim<number | string>;
  /** The document the reader filed the value under, when it isn't the one it cites. */
  readonly readAs?: string;
  readonly expect: "held" | "unsupported";
}

type Slot = (doc: string, claim: Claim<never>) => Partial<DscrReading>;

/** Where each field sits in a reading, so one flagged proposal can be replayed on its own. */
const SLOTS: Record<string, Slot> = {
  "appraisal effective": (doc, effective) => ({ appraisals: [{ doc, effective }] }),
  "market rent": (doc, marketRent) => ({ appraisals: [{ doc, marketRent }] }),
  "lease rent": (doc, rent) => ({ leases: [{ doc, rent }] }),
  "lease start": (doc, start) => ({ leases: [{ doc, start }] }),
  "lease end": (doc, end) => ({ leases: [{ doc, end }] }),
  principal: (doc, principal) => ({ notes: [{ doc, principal }] }),
  rate: (doc, rate) => ({ notes: [{ doc, rate }] }),
  term: (doc, termMonths) => ({ notes: [{ doc, termMonths }] }),
  "principal and interest": (doc, payment) => ({ notes: [{ doc, payment }] }),
  "annual tax": (doc, annual) => ({ taxBills: [{ doc, annual }] }),
  "annual premium": (doc, annual) => ({ insurance: [{ doc, annual }] }),
  "monthly dues": (doc, monthly) => ({ dues: [{ doc, monthly }] }),
};

const EMPTY: DscrReading = { appraisals: [], leases: [], notes: [], taxBills: [], insurance: [], dues: [] };

/**
 * What the gate makes of one flagged proposal, filed under the document the reader said it came
 * from (`readAs`, defaulting to the document it cites).
 */
export function replay(file: LoanFile<DscrRequest>, bad: BadOutput): GatedClaim["status"] {
  const slot = SLOTS[bad.claim.field];
  if (!slot) throw new Error(`no slot for field "${bad.claim.field}"`);
  const reader: DscrReader = () => ({ ...EMPTY, ...slot(bad.readAs ?? bad.claim.cite.doc, bad.claim as Claim<never>) });
  const gated = dscrCheck(file, { reader }).claims.find((c) => c.field === bad.claim.field);
  if (!gated) throw new Error(`the replay of "${bad.claim.field}" produced no gated claim`);
  return gated.status;
}
