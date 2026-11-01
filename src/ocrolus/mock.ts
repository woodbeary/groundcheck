/**
 * A mock of the Ocrolus side of an Encompass deployment, acting out documented behavior (checked
 * 2026-11-01) so the reconciler can be tested with no credentials. It is not evidence that
 * anything works against Ocrolus.
 *
 * - Classify watches the "Ocrolus Processing Required" eFolder container, moves a processed
 *   original to "Ocrolus Processing Complete", sends pages of unsupported form types to "UNKNOWN"
 *   and duplicate copies to "Duplicate Attachments" (docs/encompass-classify).
 * - It takes a unique lock on the loan to push results; while a person is in the loan it retries
 *   every 5 minutes for the first hour, every 15 minutes until 6 hours, hourly until 12, then
 *   stops (docs/encompass-classify).
 * - Books for Encompass loans are found with the Book-from-loan call by loan_id or loan_number,
 *   never both (reference/book-from-loan); Book names ("{Last Name} {Loan Number}") are not keys.
 * - Webhooks are signed with HMAC-SHA256 over "{timestamp}.{request_id}.{body}" in hex, in the
 *   Webhook-Signature, Webhook-Timestamp and Webhook-Request-Id headers (docs/secure-webhook-urls).
 * - Tokens last 24 hours, and the docs suggest refreshing every 12 (reference/grant-authentication-token);
 *   the API allows 20 requests per second per organization (reference/api-rate-limit-policy).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { HttpError, type MockEncompass } from "../encompass/mock.ts";

export const OCROLUS_DOC = "https://docs.ocrolus.com";

export const CONTAINER = {
  required: "Ocrolus Processing Required",
  complete: "Ocrolus Processing Complete",
  unknown: "UNKNOWN",
  duplicates: "Duplicate Attachments",
} as const;

/** A page Classify can't type, in the synthetic files: it goes to UNKNOWN. */
export const UNSUPPORTED_MARK = "SYNTHETIC UNSUPPORTED PAGE";

export interface BookDoc {
  readonly uuid: string;
  readonly name: string;
  readonly status: "PROCESSING" | "COMPLETE" | "REJECTED";
}

export interface MockBook {
  readonly uuid: string;
  readonly name: string;
  readonly loan_guid: string;
  readonly loan_number: string;
  readonly docs: BookDoc[];
}

const HOUR = 3600;

/** When Ocrolus tries to push again after `last`, counted from its first try, or STOP. */
export function nextPushTry(firstTry: number, last: number): number | "STOP" {
  const since = last - firstTry;
  const step = since < HOUR ? 5 * 60 : since < 6 * HOUR ? 15 * 60 : since < 12 * HOUR ? HOUR : null;
  if (step === null) return "STOP";
  const next = last + step;
  return next - firstTry > 12 * HOUR ? "STOP" : next;
}

export function signOcrolus(secret: string, timestamp: string, requestId: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${requestId}.${body}`).digest("hex");
}

export class MockOcrolus {
  readonly books: MockBook[] = [];
  readonly pushes = new Map<string, { firstTry: number; nextTry: number | "STOP"; done: boolean }>();
  private readonly requests: number[] = [];

  token(now: number): { access_token: string; token_type: "Bearer"; expires_in: number; issued_at: number } {
    this.count(now);
    return { access_token: `synthetic-${randomUUID()}`, token_type: "Bearer", expires_in: 24 * HOUR, issued_at: now };
  }

  /** 20 requests per second per organization; the 21st in a second is 429. */
  private count(now: number): void {
    const second = Math.floor(now);
    while (this.requests.length > 0 && this.requests[0]! < second) this.requests.shift();
    if (this.requests.length >= 20) throw new HttpError(429, "rate limit: 20 requests per second per organization");
    this.requests.push(second);
  }

  bookFromLoan(query: { readonly loan_id?: string; readonly loan_number?: string }, now = 0): MockBook {
    this.count(now);
    if ((query.loan_id === undefined) === (query.loan_number === undefined)) throw new HttpError(400, "give exactly one of loan_id or loan_number");
    const book = this.books.find((b) => (query.loan_id ? b.loan_guid === query.loan_id : b.loan_number === query.loan_number));
    if (!book) throw new HttpError(404, "no Book for that loan");
    return book;
  }

  /**
   * One Classify pass over a loan's Processing Required container at `now`. With a person in the
   * loan, the push waits on the retry schedule and stops after 12 hours.
   */
  classify(enc: MockEncompass, loanId: string, now: number, personInLoan: boolean): "pushed" | "waiting" | "stopped" | "nothing" {
    const loan = enc.loan(loanId);
    const waiting = loan.attachments.filter((a) => a.container === CONTAINER.required && a.bytes);
    if (waiting.length === 0) return "nothing";
    const push = this.pushes.get(loanId) ?? { firstTry: now, nextTry: now, done: false };
    this.pushes.set(loanId, push);
    if (push.nextTry === "STOP") return "stopped";
    if (now < push.nextTry) return "waiting";
    if (personInLoan) {
      push.nextTry = nextPushTry(push.firstTry, now);
      return push.nextTry === "STOP" ? "stopped" : "waiting";
    }
    const book = this.books.find((b) => b.loan_guid === loanId);
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const seen = new Set(loan.attachments.filter((a) => a.container === CONTAINER.complete && a.bytes).map((a) => hash(a.bytes!)));
    for (const a of waiting) {
      const h = hash(a.bytes!);
      if (seen.has(h)) {
        a.container = CONTAINER.duplicates;
        continue;
      }
      seen.add(h);
      a.container = CONTAINER.complete;
      const text = Buffer.from(a.bytes!).toString("utf8");
      if (text.includes(UNSUPPORTED_MARK)) loan.attachments.push({ id: randomUUID(), title: `${a.title} (page)`, container: CONTAINER.unknown, size: 1, createdAt: now, bytes: new Uint8Array([1]) });
      book?.docs.push({ uuid: randomUUID(), name: a.title, status: /REJECT/.test(text) ? "REJECTED" : "COMPLETE" });
    }
    push.done = true;
    this.pushes.delete(loanId);
    return "pushed";
  }

  pushState(loanId: string): { readonly state: "none" | "waiting" | "stopped"; readonly firstTry?: number } {
    const p = this.pushes.get(loanId);
    if (!p) return { state: "none" };
    return { state: p.nextTry === "STOP" ? "stopped" : "waiting", firstTry: p.firstTry };
  }
}
