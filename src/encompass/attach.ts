/**
 * Attaching a document from outside Encompass to the eFolder at most once. The V3 upload is two
 * or three writes (create the upload URL, PUT the bytes, commit a chunked file) and no
 * idempotency key appears in ICE's docs, so a retried write is how a loan file gets two copies.
 * The rule, as in the payment client this repository's author wrote for TASK: persist the
 * request before the call, and reconcile an uncertain outcome before issuing a replacement.
 *
 * 1. Write the ledger row as pending, keyed by (loan, SHA-256, container), with the title tag
 *    `ED-` + the hash's first 12 characters.
 * 2. Create the upload URL, PUT, commit if chunked. Any error, timeout or crash in here is not
 *    retried.
 * 3. Mark the row submitted and read the eFolder back.
 *
 * A lost answer is settled by lookup, never by sending again: by attachment ID, then by title
 * tag (Ocrolus renames attachments it processes), then by downloading candidates and hashing
 * them (conversion replaces the ID). Reads are retried; writes never are. If nothing matches,
 * the row closes as unconfirmed_never_resubmitted and goes to the "attach-unconfirmed" queue,
 * where a person may resubmit it, as a new attempt under their name.
 */

import { createHash } from "node:crypto";
import type { AttachRow, Ledger } from "./ledger.ts";
import { HttpError, type EncompassApi } from "./mock.ts";

export const PROCESSING_REQUIRED = "Ocrolus Processing Required";
export const UNCONFIRMED_QUEUE = "attach-unconfirmed";

export type CrashPoint = "after-url" | "after-put" | "after-commit";

export interface AttachDeps {
  readonly api: EncompassApi;
  readonly ledger: Ledger;
  /** Who asked for this attach: the connector, or a person resubmitting. */
  readonly by: string;
  /** A test hook: throw here to stand for the process dying at that point. */
  readonly crash?: (point: CrashPoint) => void;
  /** How many times a read is tried before the lookup gives up on it. */
  readonly readTries?: number;
}

export interface Outcome {
  readonly state: AttachRow["state"];
  readonly attachmentId: string | null;
  readonly how: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const titleTag = (sha: string) => `ED-${sha.slice(0, 12)}`;

const transient = (e: unknown) => e instanceof HttpError && (e.status === 429 || e.status >= 500);

/** A read, tried again on 429 and 5xx. Never used for a write. */
async function read<T>(deps: AttachDeps, work: () => Promise<T>): Promise<T> {
  const tries = deps.readTries ?? 4;
  for (let i = 1; ; i += 1) {
    try {
      return await work();
    } catch (e) {
      if (!transient(e) || i >= tries) throw e;
    }
  }
}

function outcome(row: AttachRow, how: string): Outcome {
  return { state: row.state, attachmentId: row.attachment_id, how };
}

export async function attachOnce(deps: AttachDeps, loan: string, bytes: Uint8Array, fileName: string, container = PROCESSING_REQUIRED): Promise<Outcome> {
  const sha = sha256(bytes);
  const previous = deps.ledger.latest(loan, sha, container);
  if (previous?.state === "confirmed") return outcome(previous, "already confirmed in the eFolder; nothing sent");
  if (previous?.state === "pending" || previous?.state === "submitted") return settle(deps, previous, bytes);
  if (previous?.state === "unconfirmed_never_resubmitted" && deps.by === "connector") return outcome(previous, "unconfirmed earlier; only a person resubmits it");

  let row = deps.ledger.begin(loan, sha, container, titleTag(sha), fileName, deps.by);
  try {
    const url = await deps.api.createAttachmentUploadUrl(loan, { file: { contentType: "application/pdf", name: fileName, size: bytes.length }, title: row.title_tag }, container);
    row = deps.ledger.update(row, { attachment_id: url.attachmentId });
    deps.crash?.("after-url");
    if (url.multiChunkRequired && url.multiChunk) {
      const size = Math.ceil(bytes.length / url.multiChunk.chunkList.length);
      for (const [i, chunk] of url.multiChunk.chunkList.entries()) await deps.api.upload(chunk.uploadUrl, bytes.subarray(i * size, (i + 1) * size), url.authorizationHeader);
      deps.crash?.("after-put");
      await deps.api.commit(url.multiChunk.commitUrl);
      deps.crash?.("after-commit");
    } else {
      await deps.api.upload(url.uploadUrl, bytes, url.authorizationHeader);
      deps.crash?.("after-put");
    }
  } catch (error) {
    if (error instanceof Crash) throw error;
    row = deps.ledger.update(row, { state: "submitted", note: `write failed or its answer was lost: ${(error as Error).message}` });
    return settle(deps, row, bytes);
  }
  row = deps.ledger.update(row, { state: "submitted" });
  return settle(deps, row, bytes);
}

/**
 * Settle a pending or submitted row by reading the eFolder. It never writes to Encompass.
 * Without the bytes (after a restart), the row's SHA-256 is what a download must hash to.
 */
export async function settle(deps: AttachDeps, row: AttachRow, _bytes?: Uint8Array): Promise<Outcome> {
  const matches = async (id: string) => {
    try {
      return sha256(await read(deps, () => deps.api.download(row.loan_guid, id))) === row.sha256;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false;
      throw e;
    }
  };
  const listed = await read(deps, () => deps.api.listAttachments(row.loan_guid));
  const confirm = (id: string, how: string) => outcome(deps.ledger.update(row, { state: "confirmed", attachment_id: id, note: how }), how);
  if (row.attachment_id && listed.some((a) => a.id === row.attachment_id) && (await matches(row.attachment_id))) return confirm(row.attachment_id, "found by attachment ID; the hash matches");
  for (const a of listed.filter((x) => x.title === row.title_tag)) if (await matches(a.id)) return confirm(a.id, `found by title tag ${row.title_tag}; the hash matches`);
  for (const a of listed.filter((x) => x.size > 0)) if (await matches(a.id)) return confirm(a.id, "found by downloading and hashing; the ID and title had changed");
  const closed = deps.ledger.update(row, { state: "unconfirmed_never_resubmitted", note: "no attachment in the eFolder hashes to this file; not sent again" });
  deps.ledger.queue(UNCONFIRMED_QUEUE, row.loan_guid, `${row.file_name} (${row.title_tag}) was sent but can't be found in the eFolder`, row.sha256, row.container);
  return outcome(closed, "not found by ID, title tag or hash; closed unconfirmed and queued for a person");
}

/** After a restart: settle every row that was pending or submitted when the process died. */
export async function settleOpen(deps: AttachDeps): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const row of deps.ledger.open()) out.push(await settle(deps, row));
  return out;
}

/** A person resubmits an unconfirmed file: a new attempt, recorded under their name. */
export async function resubmit(deps: AttachDeps, loan: string, bytes: Uint8Array, fileName: string, container = PROCESSING_REQUIRED): Promise<Outcome> {
  if (deps.by === "connector") throw new Error("only a person resubmits an unconfirmed attachment");
  const previous = deps.ledger.latest(loan, sha256(bytes), container);
  if (previous?.state !== "unconfirmed_never_resubmitted") throw new Error("there is no unconfirmed attempt to resubmit");
  return attachOnce(deps, loan, bytes, fileName, container);
}

/** Thrown by a test's crash hook: the process is gone, nothing after this point ran. */
export class Crash extends Error {}
