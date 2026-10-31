/**
 * Calendar days as ISO strings (YYYY-MM-DD, UTC). Every date is checked on the request's day,
 * never at build time, and anything malformed is rejected rather than coerced.
 */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const DAY_MS = 86_400_000;

/** Days since the epoch, or null for anything that isn't a real calendar day. */
export function dayNumber(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== iso) return null;
  return parsed / DAY_MS;
}

function iso(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return dayNumber(text) === null ? null : text;
}

/** Whole days from `from` to `to`; null if either is malformed. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? null : b - a;
}

/** The same calendar day `months` earlier, clamped to the month's last day (Feb 29 → Feb 28). */
export function monthsBefore(date: string, months: number): string | null {
  if (dayNumber(date) === null) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return iso(year, month, Math.min(d, last));
}

const MONTH_NAME = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

/** Date-shaped runs in printed text, each read strictly. */
const DATE_SHAPES: readonly { pattern: RegExp; read: (m: RegExpExecArray) => string | null }[] = [
  {
    pattern: new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d+)\\b`, "gi"),
    read: (m) => {
      const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase().slice(0, 3))) + 1;
      return m[3]!.length === 4 ? iso(Number(m[3]), month, Number(m[2])) : null;
    },
  },
  {
    pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d+)\b/g,
    read: (m) => (m[3]!.length === 4 ? iso(Number(m[3]), Number(m[1]), Number(m[2])) : null),
  },
  {
    pattern: /\b(\d+)-(\d{2})-(\d{2})\b/g,
    read: (m) => (m[1]!.length === 4 ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null),
  },
];

export interface DateToken {
  text: string;
  /** ISO day, or null when the printed date can't be read as one real day. */
  value: string | null;
}

/** Every date-shaped run in the text, read or marked unreadable. */
export function dateTokens(text: string): DateToken[] {
  const tokens: { at: number; token: DateToken }[] = [];
  for (const shape of DATE_SHAPES) {
    for (const m of text.matchAll(shape.pattern)) {
      tokens.push({ at: m.index, token: { text: m[0], value: shape.read(m as RegExpExecArray) } });
    }
  }
  return tokens.sort((a, b) => a.at - b.at).map((t) => t.token);
}
