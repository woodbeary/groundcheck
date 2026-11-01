/**
 * Webhook intake for both senders. Verify the signature, take the notification into the durable
 * inbox (deduplicated on its request or event id), and only then answer 2xx. Encompass never
 * retries a status from 200 to 499 (reference/wbhks-retry-logic), so a transient fault here
 * answers 503, never a 4xx; a 4xx is only for a request that is not authentic. Ocrolus waits 5
 * seconds for an answer (docs/webhook-overview), so nothing slow happens before the answer: the
 * reconciler does the work.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ledger } from "./ledger.ts";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Headers = Readonly<Record<string, string | undefined>>;
const header = (h: Headers, name: string) => Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Ocrolus: hex HMAC-SHA256 over "{timestamp}.{request_id}.{body}" (docs/secure-webhook-urls). Stale timestamps are refused. */
export function verifyOcrolus(secret: string, headers: Headers, body: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const signature = header(headers, "Webhook-Signature");
  const timestamp = header(headers, "Webhook-Timestamp");
  const requestId = header(headers, "Webhook-Request-Id");
  if (!signature || !timestamp || !requestId || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  return same(signature, createHmac("sha256", secret).update(`${timestamp}.${requestId}.${body}`).digest("hex"));
}

/**
 * Encompass: base64 HMAC-SHA256 of the body with the subscription's signing key, in
 * Elli-Signature, as ICE's Partner Connect webhook docs show it. That this is how a Developer
 * Connect subscription signs is an assumption until a sandbox run confirms it.
 */
export function verifyElli(signingKey: string, headers: Headers, body: string): boolean {
  const signature = header(headers, "Elli-Signature");
  return signature !== undefined && same(signature, createHmac("sha256", signingKey).update(body).digest("base64"));
}

export interface Answer {
  readonly status: 200 | 401 | 503;
  readonly duplicate?: boolean;
}

export function intake(ledger: Pick<Ledger, "enqueue">, source: "ocrolus" | "encompass", authentic: boolean, requestId: string | undefined, body: string): Answer {
  if (!authentic || !requestId) return { status: 401 };
  try {
    return { status: 200, duplicate: ledger.enqueue(source, requestId, body) === "duplicate" };
  } catch {
    return { status: 503 };
  }
}
