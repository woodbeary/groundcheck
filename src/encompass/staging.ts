/**
 * Staging, never overwriting. Under Encompass's shared locks an API write and a person's edit to
 * the same loan are merged and "the last update wins" (docs/loan-locks-bp; the desktop shared
 * lock since release 26.1 works the same way), so a guarded direct write ("only if the field is
 * empty") still leaves a window in which a processor's value is silently replaced. The connector
 * therefore writes only fields it owns, `CX.ED.*` custom fields, in one call (a single call takes
 * Encompass's session-less lock), and a processor moves a value into a loan field from the review
 * form, under their own login.
 */

import { formatInterval, type Interval } from "../core/interval.ts";
import type { CaptureReport } from "../ocrolus/capture.ts";
import type { EncompassApi } from "./mock.ts";

export const STAGING_PREFIX = "CX.ED.";

export const STAGED = {
  leaseRent: "CX.ED.LEASERENT",
  marketRent: "CX.ED.MARKETRENT",
  pitia: "CX.ED.PITIA",
  dscr: "CX.ED.DSCR",
  status: "CX.ED.STATUS",
  source: "CX.ED.SOURCE",
  needs: "CX.ED.NEEDS",
} as const;

const amount = (x: Interval) => (x.lo === x.hi ? x.lo.toFixed(2) : "");
const range = (x: Interval, digits: number) => formatInterval(x, (n) => n.toFixed(digits));

/** What dscr-check found, as staging-field text. A part that isn't pinned down is left blank, and NEEDS says why. */
export function stagedValues(report: CaptureReport): Record<string, string> {
  const part = (name: string) => report.parts.find((p) => p.name === name)!.value;
  return {
    [STAGED.leaseRent]: amount(part("lease rent")),
    [STAGED.marketRent]: amount(part("market rent")),
    [STAGED.pitia]: range(report.pitia, 2),
    [STAGED.dscr]: range(report.dscr, 3),
    [STAGED.status]: "Staged",
    [STAGED.source]: Object.entries(report.sources).map(([name, src]) => `${name}: ${src}`).join(" | "),
    [STAGED.needs]: report.needs.join(" | "),
  };
}

/** Write the staged values in one call. Any field outside CX.ED.* is refused before anything is sent. */
export async function stage(api: EncompassApi, loan: string, values: Readonly<Record<string, string>>, connectorUser: string): Promise<void> {
  const foreign = Object.keys(values).filter((id) => !id.startsWith(STAGING_PREFIX));
  if (foreign.length > 0) throw new Error(`the connector writes only ${STAGING_PREFIX}* fields; refused ${foreign.join(", ")}`);
  await api.setFields(loan, values, connectorUser);
}
