/**
 * The provenance log: one JSON line per gated claim, appended and never rewritten. Each row
 * carries the input file's SHA-256, where the value was quoted from, which reader proposed it
 * (and its version and prompt hash, for a model), and what the gate decided. Each row also
 * carries the hash of the line before it, so a log with a line edited, reordered or removed from
 * the middle no longer verifies. A chain can't show that lines were cut off its end: for that,
 * keep the head (`auditHead`, the last row's hash) somewhere else and verify against it.
 *
 * A person can resolve a held value. That never edits the held row: it appends a new row naming
 * who decided (`decidedBy`) and pointing at the row it resolves.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { GatedClaim, Status } from "./evidence.ts";
import { sha256 } from "./file.ts";

export interface ReaderId {
  /** "reference", "claude-json", "claude-citations", "ocrolus-capture", ... */
  readonly reader: string;
  /** The reader's version: this package's version for a pattern reader, the model id for a model. */
  readonly version: string;
  /** SHA-256 of the exact prompt and schema sent, for a model reader; null otherwise. */
  readonly promptSha: string | null;
}

export interface AuditRow {
  readonly at: string;
  readonly check: string;
  readonly file: string;
  readonly sha256: string;
  readonly reader: string;
  readonly readerVersion: string;
  readonly promptSha: string | null;
  readonly field: string;
  readonly doc: string;
  readonly page: number;
  readonly quote: string;
  readonly value: unknown;
  readonly status: Status | "resolved";
  readonly reason: string | null;
  /** Who settled this value: null for the gate; a person's name on a resolution row. */
  readonly decidedBy: string | null;
  /** The hash of the row a resolution settles; null on a gate row. */
  readonly resolves: string | null;
  /** The hash of the previous line in the log ("" for the first). */
  readonly prev: string;
}

export interface Run {
  readonly check: string;
  readonly file: string;
  readonly sha256: string;
  readonly claims: readonly GatedClaim[];
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function lastHash(path: string): string {
  const all = lines(path);
  return all.length === 0 ? "" : sha256(all[all.length - 1]!);
}

/** The hash of the log's last row ("" when empty): kept elsewhere, it lets `verifyAudit` catch a cut-off tail. */
export function auditHead(path: string): string {
  return lastHash(path);
}

/** The rows a run adds, chained onto whatever the log already holds. */
export function appendRun(path: string, run: Run, reader: ReaderId, at = new Date().toISOString()): AuditRow[] {
  let prev = lastHash(path);
  const rows: AuditRow[] = [];
  let text = "";
  for (const c of run.claims) {
    const row: AuditRow = {
      at,
      check: run.check,
      file: run.file,
      sha256: run.sha256,
      reader: reader.reader,
      readerVersion: reader.version,
      promptSha: reader.promptSha,
      field: c.field,
      doc: c.doc,
      page: c.page,
      quote: c.quote,
      value: c.value,
      status: c.status,
      reason: c.reason ?? null,
      decidedBy: null,
      resolves: null,
      prev,
    };
    const line = JSON.stringify(row);
    prev = sha256(line);
    rows.push(row);
    text += `${line}\n`;
  }
  appendFileSync(path, text, { flag: "a" });
  return rows;
}

export function readAudit(path: string): AuditRow[] {
  return lines(path).map((line) => JSON.parse(line) as AuditRow);
}

/**
 * The first line whose chain is broken, or null when the log is intact. Given the head kept from
 * an earlier `auditHead`, a log that no longer reaches that row fails too.
 */
export function verifyAudit(path: string, head?: string): { line: number; reason: string } | null {
  let prev = "";
  const all = lines(path);
  let reached = head === undefined || head === "";
  for (const [i, line] of all.entries()) {
    const row = JSON.parse(line) as AuditRow;
    if (row.prev !== prev) return { line: i + 1, reason: "the previous line was changed, removed or reordered" };
    prev = sha256(line);
    if (prev === head) reached = true;
  }
  return reached ? null : { line: all.length + 1, reason: "the log no longer reaches the head kept for it: lines were cut off the end" };
}

/**
 * A person settles a held value. The held row stays as it was; a new row records the value they
 * chose, their name and the row it resolves. Only a held row can be resolved, and only once.
 */
export function resolveHeld(path: string, heldLine: number, decision: { readonly decidedBy: string; readonly value: unknown; readonly reason: string }, at = new Date().toISOString()): AuditRow {
  if (!decision.decidedBy.trim()) throw new Error("a resolution needs the name of the person who decided it");
  const all = lines(path);
  const target = all[heldLine - 1];
  if (target === undefined) throw new Error(`no line ${heldLine} in the log`);
  const held = JSON.parse(target) as AuditRow;
  if (held.status !== "held") throw new Error(`line ${heldLine} is ${held.status}, not held; only a held value is resolved by a person`);
  const ref = sha256(target);
  if (all.some((line) => (JSON.parse(line) as AuditRow).resolves === ref)) throw new Error(`line ${heldLine} is already resolved`);
  const row: AuditRow = { ...held, at, value: decision.value, status: "resolved", reason: decision.reason, decidedBy: decision.decidedBy, resolves: ref, prev: lastHash(path) };
  appendFileSync(path, `${JSON.stringify(row)}\n`, { flag: "a" });
  return row;
}
