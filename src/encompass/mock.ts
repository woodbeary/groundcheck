/**
 * A mock Encompass Developer Connect instance that acts out documented behaviors, so the attach
 * path, the reconciler, the staging writer and the review form can be tested with no
 * credentials. It is built from ICE's public docs (checked 2026-11-01), not from recorded
 * traffic, and it is not evidence that any of this works against a live instance.
 *
 * Modeled, each from its page:
 * - V3 attachment upload: create an upload URL (POST /encompass/v3/loans/{loanId}/attachmentUploadUrl,
 *   body { file: { contentType, name, size }, title }), then PUT the bytes; over 60 MB the response
 *   lists 20 MB chunk URLs and a commit URL (reference/create-attachment-url);
 * - downloading by attachment id (reference/get-download-attachment-url);
 * - with document conversion on, the first attachment ID "will no longer be valid and it will be
 *   replaced with a GUID" (reference/upload-attachment-to-efolder);
 * - shared locks: API updates are allowed while a user edits, and "the last update wins"
 *   (docs/loan-locks-bp); enhancedfieldchange events carry previousValue and meta.userId
 *   (reference/wbhks-re-cat-loan);
 * - concurrency: a hard limit of 30 concurrent calls per lender environment, 429 when it is used,
 *   and X-Concurrency-Limit-Limit / -Remaining headers (docs/concurrency-limits);
 * - webhook delivery: by default three linear tries 20 s apart, then discarded; with
 *   deliveryPolicy exponential, retries for 8 hours on the documented schedule; a status from 200
 *   to 499 is never retried (reference/wbhks-retry-logic); ICE deletes subscriptions whose
 *   endpoints are undeliverable (reference/subscriptions).
 *
 * Simplified, and said so: an attachment's eFolder container is set when it is uploaded (the real
 * API assigns it through the eFolder document APIs), listing returns id, title, size, container
 * and creation time, and ICE's deletion criteria are reduced to "its last delivery failed".
 */

import { randomUUID } from "node:crypto";

export const DOC = "https://developer.icemortgagetechnology.com/developer-connect";

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(`${status} ${message}`);
    this.status = status;
    this.headers = headers;
  }
}

export interface Attachment {
  id: string;
  title: string;
  container: string;
  size: number;
  createdAt: number;
  bytes: Uint8Array | null;
}

export interface UploadUrl {
  readonly attachmentId: string;
  readonly uploadUrl: string;
  readonly authorizationHeader: string;
  readonly multiChunkRequired: boolean;
  readonly multiChunk?: { readonly chunkList: readonly { readonly uploadUrl: string }[]; readonly commitUrl: string };
}

export interface LoanEvent {
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly meta: { readonly userId: string; readonly resourceType: "Loan"; readonly resourceId: string; readonly instanceId: string; readonly payload?: unknown };
}

export interface Subscription {
  readonly subscriptionId: string;
  readonly endpoint: string;
  readonly resource: string;
  readonly events: readonly string[];
  readonly deliveryPolicy?: { readonly backoff: "linear" | "exponential" };
  readonly signingkey: string;
}

export type Endpoint = (event: LoanEvent) => number | "timeout";

/** The calls the connector makes. The mock implements them; a live client would make the same calls over HTTPS. */
export interface EncompassApi {
  createAttachmentUploadUrl(loanId: string, body: { file: { contentType: string; name: string; size: number }; title: string }, container: string): Promise<UploadUrl>;
  upload(url: string, bytes: Uint8Array, authorizationHeader: string): Promise<{ status: number }>;
  commit(commitUrl: string): Promise<{ status: number }>;
  listAttachments(loanId: string): Promise<{ id: string; title: string; size: number; container: string; createdAt: number }[]>;
  download(loanId: string, attachmentId: string): Promise<Uint8Array>;
  getFields(loanId: string, ids: readonly string[]): Promise<Record<string, string>>;
  setFields(loanId: string, values: Readonly<Record<string, string>>, userId: string): Promise<void>;
}

const MB = 1024 * 1024;
/** Exponential delivery: seconds after the original event, from the retry-logic table. */
export const EXPONENTIAL_RETRIES = [30, 60, 120, 240, 480, 960, 1920, 3600, 7200, 10800, 14400, 18000, 21600, 25200, 28800];

export interface MockOptions {
  /** With document conversion on, an uploaded attachment's ID is replaced with a new GUID. */
  documentConversion?: boolean;
  /** Whether creating an upload URL leaves an empty attachment record before the PUT (unknown until a sandbox run). */
  emptyRecordOnUrl?: boolean;
  concurrencyLimit?: number;
  instanceId?: string;
}

export class MockEncompass implements EncompassApi {
  readonly options: Required<MockOptions>;
  readonly loans = new Map<string, { attachments: Attachment[]; fields: Map<string, string> }>();
  readonly subscriptions: Subscription[] = [];
  readonly endpoints = new Map<string, Endpoint>();
  readonly deliveries: { eventId: string; subscriptionId: string; atSeconds: number; status: number | "timeout" }[] = [];
  readonly discarded: string[] = [];
  readonly calls: Record<string, number> = {};
  readonly pending = new Map<string, { loanId: string; attachmentId: string; container: string; title: string; chunks: (Uint8Array | null)[] }>();
  /** Calls in flight from everyone else in the lender's environment: its staff, Ocrolus, other vendors. */
  background = 0;
  clock = 0;
  /** The next PUT answers 200 and keeps nothing: a success that lies. */
  dropNextPut = false;
  private inFlight = 0;

  constructor(options: MockOptions = {}) {
    this.options = { documentConversion: false, emptyRecordOnUrl: false, concurrencyLimit: 30, instanceId: "TEBE11111111", ...options };
  }

  loan(loanId: string) {
    return this.loans.get(loanId) ?? this.loans.set(loanId, { attachments: [], fields: new Map() }).get(loanId)!;
  }

  headers(): Record<string, string> {
    const limit = this.options.concurrencyLimit;
    return { "X-Concurrency-Limit-Limit": String(limit), "X-Concurrency-Limit-Remaining": String(Math.max(0, limit - this.background - this.inFlight)) };
  }

  /** Every call counts against the environment's concurrency; at the limit, everyone gets 429. */
  private async call<T>(name: string, work: () => T): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.background + this.inFlight >= this.options.concurrencyLimit) throw new HttpError(429, "Too Many Requests", this.headers());
    this.inFlight += 1;
    try {
      return work();
    } finally {
      this.inFlight -= 1;
    }
  }

  createAttachmentUploadUrl(loanId: string, body: { file: { contentType: string; name: string; size: number }; title: string }, container: string): Promise<UploadUrl> {
    return this.call("createAttachmentUploadUrl", () => {
      const attachmentId = randomUUID();
      const chunks = body.file.size > 60 * MB ? Math.ceil(body.file.size / (20 * MB)) : 1;
      this.pending.set(attachmentId, { loanId, attachmentId, container, title: body.title, chunks: Array.from({ length: chunks }, () => null) });
      if (this.options.emptyRecordOnUrl) this.loan(loanId).attachments.push({ id: attachmentId, title: body.title, container, size: 0, createdAt: this.clock, bytes: null });
      const url = (part: number) => `https://streaming.example.invalid/v1/sessions/${attachmentId}?partNumber=${part}`;
      return chunks === 1
        ? { attachmentId, uploadUrl: url(1), authorizationHeader: "elli-signature synthetic", multiChunkRequired: false }
        : { attachmentId, uploadUrl: url(1), authorizationHeader: "elli-signature synthetic", multiChunkRequired: true, multiChunk: { chunkList: Array.from({ length: chunks }, (_, i) => ({ uploadUrl: url(i + 1) })), commitUrl: `https://streaming.example.invalid/v1/sessions/${attachmentId}?action=commit` } };
    });
  }

  upload(url: string, bytes: Uint8Array, authorizationHeader: string): Promise<{ status: number }> {
    return this.call("upload", () => {
      if (!authorizationHeader) throw new HttpError(401, "missing authorization header");
      const id = /sessions\/([^?]+)/.exec(url)?.[1] ?? "";
      const part = Number(/partNumber=(\d+)/.exec(url)?.[1] ?? 1);
      const p = this.pending.get(id);
      if (!p) throw new HttpError(404, "no such upload session");
      if (this.dropNextPut) {
        this.dropNextPut = false;
        return { status: 200 };
      }
      p.chunks[part - 1] = bytes;
      if (p.chunks.length === 1) this.store(p);
      return { status: 200 };
    });
  }

  commit(commitUrl: string): Promise<{ status: number }> {
    return this.call("commit", () => {
      const id = /sessions\/([^?]+)/.exec(commitUrl)?.[1] ?? "";
      const p = this.pending.get(id);
      if (!p || p.chunks.some((c) => c === null)) throw new HttpError(400, "not every chunk was uploaded");
      this.store(p);
      return { status: 200 };
    });
  }

  private store(p: { loanId: string; attachmentId: string; container: string; title: string; chunks: (Uint8Array | null)[] }): void {
    this.pending.delete(p.attachmentId);
    const bytes = Buffer.concat(p.chunks.map((c) => c!));
    const attachments = this.loan(p.loanId).attachments;
    const existing = attachments.find((a) => a.id === p.attachmentId);
    const id = this.options.documentConversion ? randomUUID() : p.attachmentId;
    if (existing) Object.assign(existing, { id, bytes, size: bytes.length });
    else attachments.push({ id, title: p.title, container: p.container, size: bytes.length, createdAt: this.clock, bytes });
  }

  listAttachments(loanId: string) {
    return this.call("listAttachments", () => this.loan(loanId).attachments.map(({ id, title, size, container, createdAt }) => ({ id, title, size, container, createdAt })));
  }

  download(loanId: string, attachmentId: string): Promise<Uint8Array> {
    return this.call("download", () => {
      const a = this.loan(loanId).attachments.find((x) => x.id === attachmentId);
      if (!a) throw new HttpError(404, "attachment not found");
      if (!a.bytes) throw new HttpError(404, "attachment has no file");
      return a.bytes;
    });
  }

  getFields(loanId: string, ids: readonly string[]): Promise<Record<string, string>> {
    return this.call("getFields", () => Object.fromEntries(ids.map((id) => [id, this.loan(loanId).fields.get(id) ?? ""])));
  }

  /** Shared lock: whoever writes last wins, and each change is an enhancedfieldchange event. */
  setFields(loanId: string, values: Readonly<Record<string, string>>, userId: string): Promise<void> {
    return this.call("setFields", () => {
      const fields = this.loan(loanId).fields;
      const changes = Object.entries(values).map(([id, newValue]) => ({ modifiedField: id, parentFieldId: id, encompass: { previousValue: fields.get(id) ?? "", newValue } }));
      for (const [id, v] of Object.entries(values)) fields.set(id, v);
      this.emit(loanId, "enhancedfieldchange", userId, { event: { fieldChangeEvents: changes } });
    });
  }

  subscribe(sub: Omit<Subscription, "subscriptionId">, endpoint: Endpoint): string {
    const subscriptionId = randomUUID();
    this.subscriptions.push({ ...sub, subscriptionId });
    this.endpoints.set(subscriptionId, endpoint);
    return subscriptionId;
  }

  /** Deliver an event to every matching subscription, acting out the delivery policy. */
  emit(loanId: string, eventType: string, userId: string, payload?: unknown): LoanEvent {
    const event: LoanEvent = { eventId: randomUUID(), eventTime: new Date(Date.UTC(2026, 10, 1) + this.clock * 1000).toISOString(), eventType, meta: { userId, resourceType: "Loan", resourceId: loanId, instanceId: this.options.instanceId, ...(payload === undefined ? {} : { payload }) } };
    for (const sub of this.subscriptions.filter((s) => s.resource === "Loan" && s.events.includes(eventType))) {
      const endpoint = this.endpoints.get(sub.subscriptionId)!;
      const schedule = sub.deliveryPolicy?.backoff === "exponential" ? [0, ...EXPONENTIAL_RETRIES] : [0, 20, 40];
      let delivered = false;
      for (const at of schedule) {
        const status = endpoint(event);
        this.deliveries.push({ eventId: event.eventId, subscriptionId: sub.subscriptionId, atSeconds: at, status });
        if (status !== "timeout" && status >= 200 && status <= 499) {
          delivered = true;
          break;
        }
      }
      if (!delivered) this.discarded.push(event.eventId);
    }
    return event;
  }

  /** ICE's periodic review, reduced to its effect: a subscription whose endpoint is undeliverable is deleted. */
  reviewSubscriptions(): void {
    for (const sub of [...this.subscriptions]) {
      const last = this.deliveries.filter((d) => d.subscriptionId === sub.subscriptionId).at(-1);
      if (last && (last.status === "timeout" || last.status >= 500)) this.subscriptions.splice(this.subscriptions.indexOf(sub), 1);
    }
  }

  async listSubscriptions(): Promise<Subscription[]> {
    return this.call("listSubscriptions", () => [...this.subscriptions]);
  }
}
