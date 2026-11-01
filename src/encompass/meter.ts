/**
 * Staying out of everyone else's way. A lender environment has a hard stop of 30 concurrent
 * calls by default, shared by its own staff, Ocrolus and every other vendor; at the limit all of
 * them get 429. ICE asks an ISV partner to keep (Limit - Remaining) / Limit at or under 20%, and
 * a lender's own integration under 80%, metering on X-Concurrency-Limit-Limit and
 * X-Concurrency-Limit-Remaining, with exponential backoff on 429 (docs/concurrency-limits,
 * checked 2026-11-01). Ocrolus gets its own budget: 20 requests per second per organization.
 */

export type Role = "isv" | "lender";

export class ConcurrencyMeter {
  readonly maxRatio: number;
  private limit = 30;
  private remaining = 30;

  constructor(role: Role) {
    this.maxRatio = role === "isv" ? 0.2 : 0.8;
  }

  observe(headers: Readonly<Record<string, string>>): void {
    const limit = Number(headers["X-Concurrency-Limit-Limit"]);
    const remaining = Number(headers["X-Concurrency-Limit-Remaining"]);
    if (Number.isFinite(limit) && limit > 0) this.limit = limit;
    if (Number.isFinite(remaining)) this.remaining = remaining;
  }

  /** The share of the environment's concurrency in use, as ICE defines the ratio. */
  ratio(): number {
    return (this.limit - this.remaining) / this.limit;
  }

  /** Whether one more call would keep the ratio at or under this role's ceiling. */
  mayCall(): boolean {
    return (this.limit - this.remaining + 1) / this.limit <= this.maxRatio;
  }
}

/** Exponential backoff after a 429: 1 s, 2 s, 4 s ... capped at 64 s. */
export function backoffSeconds(attempt: number): number {
  return Math.min(64, 2 ** Math.max(0, attempt - 1));
}

/** A separate budget for Ocrolus: at most `perSecond` calls in any one second. */
export class PerSecondBudget {
  readonly perSecond: number;
  private second = -1;
  private used = 0;

  constructor(perSecond = 20) {
    this.perSecond = perSecond;
  }

  take(nowSeconds: number): boolean {
    const s = Math.floor(nowSeconds);
    if (s !== this.second) {
      this.second = s;
      this.used = 0;
    }
    if (this.used >= this.perSecond) return false;
    this.used += 1;
    return true;
  }
}
