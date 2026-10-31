/**
 * The rule both checks share, carried over from the HELOC engine's decision core: every fact is
 * a closed range of the values the documents allow, and a check is three-valued over that range.
 * It passes only if it holds for every value, fails only if it holds for none, and is unknown
 * otherwise. A fact nobody can back is the widest range, so missing evidence can only cost a pass,
 * never invent one.
 */

export type Tri = "pass" | "fail" | "unknown";

/** Closed range of non-negative amounts. `hi` may be Infinity. */
export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

export const ZERO: Interval = { lo: 0, hi: 0 };

/** An amount no current document backs: anything from zero up. */
export const UNBACKED: Interval = { lo: 0, hi: Infinity };

export function point(x: number): Interval {
  return { lo: x, hi: x };
}

export function isPoint(x: Interval): boolean {
  return x.lo === x.hi;
}

export function add(a: Interval, b: Interval): Interval {
  return { lo: a.lo + b.lo, hi: a.hi + b.hi };
}

export function sum(xs: readonly Interval[]): Interval {
  return xs.reduce(add, ZERO);
}

/** Multiply by a non-negative constant. */
export function scale(x: Interval, k: number): Interval {
  return { lo: x.lo * k, hi: x.hi === Infinity ? (k === 0 ? 0 : Infinity) : x.hi * k };
}

/** min(a, b) for every pair of values: the lesser of two amounts. */
export function lesser(a: Interval, b: Interval): Interval {
  return { lo: Math.min(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
}

/** Smallest range holding both: two current documents that disagree. */
export function hull(a: Interval, b: Interval): Interval {
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

/** a ÷ b for non-negative ranges. A divisor that may be zero leaves the top open. */
export function ratio(a: Interval, b: Interval): Interval {
  if (b.hi <= 0) return UNBACKED;
  return {
    lo: b.hi === Infinity ? 0 : a.lo / b.hi,
    hi: b.lo <= 0 || a.hi === Infinity ? Infinity : a.hi / b.lo,
  };
}

/** a as a percent of b. */
export function percentOf(a: Interval, b: Interval): Interval {
  return scale(ratio(a, b), 100);
}

/** Does every value of x lie within [lo, hi]? */
export function inside(x: Interval, lo: number, hi: number): Tri {
  if (x.lo >= lo && x.hi <= hi) return "pass";
  if (x.hi < lo || x.lo > hi) return "fail";
  return "unknown";
}

export function atLeast(x: Interval, min: number): Tri {
  return inside(x, min, Infinity);
}

export function atMost(x: Interval, max: number): Tri {
  return inside(x, -Infinity, max);
}

export function all(results: readonly Tri[]): Tri {
  if (results.includes("fail")) return "fail";
  return results.includes("unknown") ? "unknown" : "pass";
}

export function formatInterval(x: Interval, unit: (n: number) => string): string {
  if (isPoint(x)) return unit(x.lo);
  return `${unit(x.lo)} to ${x.hi === Infinity ? "unbounded" : unit(x.hi)}`;
}
