/**
 * The ledger: SQLite in WAL mode, built by the SQL files in migrations/, applied in order and
 * recorded in schema_migrations. Inside a lender's tenant the same tables would live in their
 * database (Postgres, say); nothing here depends on SQLite beyond the driver.
 *
 * An attachment is keyed by (loan GUID, SHA-256, container) and an attempt number, never by the
 * attachment ID, which Encompass replaces after document conversion. Each row also carries the
 * title tag the upload was given, for the lookup that settles a lost answer.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS = new URL("../../migrations/", import.meta.url).pathname;

export type AttachState = "pending" | "submitted" | "confirmed" | "unconfirmed_never_resubmitted";

export interface AttachRow {
  readonly loan_guid: string;
  readonly sha256: string;
  readonly container: string;
  readonly attempt: number;
  readonly title_tag: string;
  readonly file_name: string;
  readonly state: AttachState;
  readonly attachment_id: string | null;
  readonly requested_by: string;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export class Ledger {
  readonly db: DatabaseSync;
  readonly now: () => string;

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set((this.db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      if (applied.has(name)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(name, this.now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  journalMode(): string {
    return (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  }

  latest(loan: string, sha256: string, container: string): AttachRow | null {
    return (this.db.prepare("SELECT * FROM attach_ledger WHERE loan_guid = ? AND sha256 = ? AND container = ? ORDER BY attempt DESC LIMIT 1").get(loan, sha256, container) as AttachRow | undefined) ?? null;
  }

  /** A new attempt, written before any request is made. */
  begin(loan: string, sha256: string, container: string, titleTag: string, fileName: string, requestedBy: string): AttachRow {
    const attempt = (this.latest(loan, sha256, container)?.attempt ?? 0) + 1;
    const now = this.now();
    this.db.prepare("INSERT INTO attach_ledger (loan_guid, sha256, container, attempt, title_tag, file_name, state, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)").run(loan, sha256, container, attempt, titleTag, fileName, requestedBy, now, now);
    return this.latest(loan, sha256, container)!;
  }

  update(row: AttachRow, change: { state?: AttachState; attachment_id?: string | null; note?: string }): AttachRow {
    this.db
      .prepare("UPDATE attach_ledger SET state = ?, attachment_id = ?, note = ?, updated_at = ? WHERE loan_guid = ? AND sha256 = ? AND container = ? AND attempt = ?")
      .run(change.state ?? row.state, change.attachment_id === undefined ? row.attachment_id : change.attachment_id, change.note ?? row.note, this.now(), row.loan_guid, row.sha256, row.container, row.attempt);
    return this.db.prepare("SELECT * FROM attach_ledger WHERE loan_guid = ? AND sha256 = ? AND container = ? AND attempt = ?").get(row.loan_guid, row.sha256, row.container, row.attempt) as unknown as AttachRow;
  }

  open(): AttachRow[] {
    return this.db.prepare("SELECT * FROM attach_ledger WHERE state IN ('pending', 'submitted') ORDER BY created_at").all() as unknown as AttachRow[];
  }

  forLoan(loan: string): AttachRow[] {
    return this.db.prepare("SELECT * FROM attach_ledger WHERE loan_guid = ? ORDER BY created_at, attempt").all(loan) as unknown as AttachRow[];
  }

  queue(queue: string, loan: string, reason: string, sha256: string | null = null, container: string | null = null): void {
    this.db.prepare("INSERT INTO review_queue (queue, loan_guid, sha256, container, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(queue, loan, sha256, container, reason, this.now());
  }

  queued(queue: string): { loan_guid: string; sha256: string | null; reason: string }[] {
    return this.db.prepare("SELECT loan_guid, sha256, reason FROM review_queue WHERE queue = ? ORDER BY id").all(queue) as { loan_guid: string; sha256: string | null; reason: string }[];
  }

  /** Durable enqueue of a notification; "duplicate" when that request id was already taken in. */
  enqueue(source: string, requestId: string, body: string): "new" | "duplicate" {
    const r = this.db.prepare("INSERT OR IGNORE INTO inbox (source, request_id, received_at, body) VALUES (?, ?, ?, ?)").run(source, requestId, this.now(), body);
    return Number(r.changes) === 1 ? "new" : "duplicate";
  }

  inbox(source: string): { request_id: string; body: string }[] {
    return this.db.prepare("SELECT request_id, body FROM inbox WHERE source = ? ORDER BY received_at").all(source) as { request_id: string; body: string }[];
  }

  close(): void {
    this.db.close();
  }
}
