/**
 * The reconciler. Health comes only from reading the eFolder and the Ocrolus Book back, never
 * from counting requests sent or webhooks heard: default Encompass webhooks are discarded after
 * three tries, ICE deletes subscriptions whose endpoints fail, and a PUT can answer 200 and keep
 * nothing. Per active loan it counts:
 *
 * - confirmed: ledger files whose SHA-256 is in the eFolder, in Processing Required or, once
 *   Ocrolus has run, Processing Complete; missing: ones that aren't;
 * - stuck: attachments still in Processing Required after the configured time;
 * - UNKNOWN pages and Duplicate Attachments, which a person reviews;
 * - rejected Book documents, and a lock-stalled push (Ocrolus stopped retrying after 12 hours);
 * - whether the connector's webhook subscription still exists.
 *
 * The Book is found with Book-from-loan by loan GUID, never by name.
 */

import { createHash } from "node:crypto";
import { CONTAINER, type MockOcrolus } from "../ocrolus/mock.ts";
import type { Ledger } from "./ledger.ts";
import type { EncompassApi, Subscription } from "./mock.ts";

export interface LoanHealth {
  readonly loan: string;
  readonly book: string | null;
  readonly containers: Readonly<Record<string, number>>;
  readonly expected: number;
  readonly confirmed: number;
  readonly missing: readonly string[];
  readonly unconfirmed: number;
  readonly stuck: readonly string[];
  readonly unknownPages: number;
  readonly duplicates: number;
  readonly rejected: readonly string[];
  readonly lockStalled: boolean;
  readonly subscriptionAlive: boolean;
  readonly health: "green" | "red";
  readonly reasons: readonly string[];
}

export interface ReconcileDeps {
  readonly api: EncompassApi;
  readonly ocrolus: Pick<MockOcrolus, "bookFromLoan" | "pushState">;
  readonly ledger: Ledger;
  readonly listSubscriptions: () => Promise<readonly Subscription[]>;
  readonly subscriptionId: string;
  readonly now: number;
  /** An attachment in Processing Required longer than this is stuck. A setting. */
  readonly stuckAfterSeconds: number;
}

export async function reconcileLoan(deps: ReconcileDeps, loan: string): Promise<LoanHealth> {
  const reasons: string[] = [];
  let book: { uuid: string; docs: readonly { name: string; status: string }[] } | null = null;
  try {
    book = deps.ocrolus.bookFromLoan({ loan_id: loan }, deps.now);
  } catch (e) {
    reasons.push(`no Ocrolus Book for this loan: ${(e as Error).message}`);
  }
  const listed = await deps.api.listAttachments(loan);
  const containers: Record<string, number> = {};
  for (const a of listed) containers[a.container] = (containers[a.container] ?? 0) + 1;

  const hashes = new Map<string, string>();
  for (const a of listed.filter((x) => (x.container === CONTAINER.required || x.container === CONTAINER.complete) && x.size > 0)) {
    hashes.set(createHash("sha256").update(await deps.api.download(loan, a.id)).digest("hex"), a.id);
  }
  const rows = deps.ledger.forLoan(loan);
  const expected = rows.filter((r) => r.state === "submitted" || r.state === "confirmed");
  const missing = expected.filter((r) => !hashes.has(r.sha256)).map((r) => `${r.file_name} (${r.title_tag})`);
  const unconfirmed = rows.filter((r) => r.state === "unconfirmed_never_resubmitted" && !rows.some((x) => x.sha256 === r.sha256 && x.attempt > r.attempt)).length;
  const stuck = listed.filter((a) => a.container === CONTAINER.required && deps.now - a.createdAt > deps.stuckAfterSeconds).map((a) => a.title);
  const rejected = (book?.docs ?? []).filter((d) => d.status === "REJECTED").map((d) => d.name);
  const lockStalled = deps.ocrolus.pushState(loan).state === "stopped";
  const subscriptionAlive = (await deps.listSubscriptions()).some((s) => s.subscriptionId === deps.subscriptionId);

  if (missing.length) reasons.push(`confirmed in the eFolder: ${expected.length - missing.length} of ${expected.length}; missing ${missing.join(", ")}`);
  if (unconfirmed) reasons.push(`${unconfirmed} attachment(s) unconfirmed, waiting for a person`);
  if (stuck.length) reasons.push(`stuck in ${CONTAINER.required}: ${stuck.join(", ")}`);
  if (rejected.length) reasons.push(`rejected by Ocrolus: ${rejected.join(", ")}`);
  if (lockStalled) reasons.push("Ocrolus stopped retrying its push after 12 hours: someone has had the loan open");
  if (!subscriptionAlive) reasons.push("the webhook subscription is gone (ICE deletes undeliverable ones)");
  return {
    loan,
    book: book?.uuid ?? null,
    containers,
    expected: expected.length,
    confirmed: expected.length - missing.length,
    missing,
    unconfirmed,
    stuck,
    unknownPages: containers[CONTAINER.unknown] ?? 0,
    duplicates: containers[CONTAINER.duplicates] ?? 0,
    rejected,
    lockStalled,
    subscriptionAlive,
    health: reasons.length === 0 ? "green" : "red",
    reasons,
  };
}

/** The day's counts across active loans, for the daily report Ocrolus containers deserve. */
export function dailyCounts(day: string, healths: readonly LoanHealth[]): { day: string; loans: number; red: number; containers: Record<string, number>; unknownPages: number; duplicates: number } {
  const containers: Record<string, number> = {};
  for (const h of healths) for (const [c, n] of Object.entries(h.containers)) containers[c] = (containers[c] ?? 0) + n;
  return { day, loans: healths.length, red: healths.filter((h) => h.health === "red").length, containers, unknownPages: healths.reduce((n, h) => n + h.unknownPages, 0), duplicates: healths.reduce((n, h) => n + h.duplicates, 0) };
}
