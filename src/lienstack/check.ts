/**
 * lienstack: the liens a title report shows, checked against a second-lien HELOC's lien rules,
 * with combined loan-to-value as a range that only cited, current documents can narrow.
 *
 * Presence and absence are not symmetric. A lien printed on the current report proves it exists,
 * so it can fail a rule even when another page is missing. "No tax lien" is a claim about every
 * item, so it can pass only when the current report is whole, fresh, and every numbered item on
 * it was read. Title reports print a lien's recorded amount, not what is owed today, so a balance
 * comes only from a current statement that provably belongs to that lien.
 */

import { daysBetween, monthsBefore } from "../core/dates.ts";
import { dollars } from "../core/format.ts";
import {
  backed,
  checkDate,
  checkLabel,
  checkMoney,
  checkText,
  wholeness,
  type Checked,
  type Doc,
} from "../core/evidence.ts";
import { UNBACKED, ZERO, add, all, atMost, hull, inside, percentOf, point, sum, type Interval, type Tri } from "../core/interval.ts";
import {
  MORTGAGE_KINDS,
  kindOf,
  type Check,
  type HelocFacts,
  type ItemReading,
  type LienKind,
  type LienPolicy,
  type LienReport,
  type LienRequest,
  type LienView,
  type Problem,
  type ReportReading,
  type TitleReading,
} from "./types.ts";

interface Item {
  readonly number: number;
  readonly kind: Checked<LienKind>;
  readonly recorded?: Checked<string>;
  readonly instrument?: Checked<string>;
  readonly amount?: Checked<number>;
  readonly holder?: Checked<string>;
}

interface Lien {
  readonly item: Item;
  readonly kind: LienKind;
  readonly stays: LienView["stays"];
  readonly balance: Interval;
  readonly balanceBecause: string;
}

/** Where the title stands on the request date. */
interface TitleState {
  readonly report: ReportReading | null;
  readonly effective: string | null;
  readonly superseded: readonly string[];
  /** The current report is known and fresh: what it prints can fail a rule. */
  readonly decided: boolean;
  /** ...and whole, with every numbered item read: what it doesn't print can pass one. */
  readonly complete: boolean;
  readonly because: string;
}

const LABELS = {
  recorded: { name: "recording", pattern: /\brecorded\b/i },
  instrument: { name: "instrument number", pattern: /Instrument No/i },
  amount: { name: "amount", pattern: /amount of|\bfor\s+\$/i },
  holder: { name: "beneficiary or creditor", pattern: /Beneficiary|Creditor|Lender/i },
  effective: { name: "effective date", pattern: /Effective Date/i },
  statementDate: { name: "statement date", pattern: /Statement Date/i },
  original: { name: "original principal or credit limit", pattern: /Original Principal|Credit Limit/i },
  balance: { name: "principal balance", pattern: /Principal Balance/i },
} as const;

/**
 * Every field of an item must be quoted from that item's own numbered line in the same report,
 * and the line must start with the item's number.
 */
function gateItem(docs: readonly Doc[], doc: string, reading: ItemReading): Item {
  const line = { name: `item ${reading.number}`, pattern: new RegExp(`^${reading.number}\\.\\s`) };
  const item = { doc, page: reading.kind.cite.page, within: reading.kind.cite.span };
  return {
    number: reading.number,
    kind: checkLabel(docs, reading.kind, kindOf, { doc, label: line }),
    ...(reading.recorded ? { recorded: checkDate(docs, reading.recorded, { ...item, label: LABELS.recorded }) } : {}),
    ...(reading.instrument ? { instrument: checkText(docs, reading.instrument, { ...item, label: LABELS.instrument }) } : {}),
    ...(reading.amount ? { amount: checkMoney(docs, reading.amount, { ...item, label: LABELS.amount }) } : {}),
    ...(reading.holder ? { holder: checkText(docs, reading.holder, { ...item, label: LABELS.holder }) } : {}),
  };
}

/** Numbered lines on the report's Schedule B pages: what a reader has to account for. */
function printedItems(doc: Doc): number[] {
  return doc.pages
    .filter((p) => /SCHEDULE B/i.test(p.text))
    .flatMap((p) => p.text.split("\n").flatMap((l) => {
      const m = /^\s*(\d{1,2})\.\s/.exec(l);
      return m ? [Number(m[1])] : [];
    }));
}

function titleState(docs: readonly Doc[], reading: TitleReading, request: LienRequest, policy: LienPolicy): TitleState {
  const none = (because: string, superseded: string[] = []): TitleState => ({ report: null, effective: null, superseded, decided: false, complete: false, because });
  if (reading.reports.length === 0) return none("no title report in the file");

  const dated = reading.reports.map((report) => ({
    report,
    effective: report.effective ? checkDate(docs, report.effective, { doc: report.doc, label: LABELS.effective }) : undefined,
  }));
  const undated = dated.find((d) => backed(d.effective) === null);
  if (undated) {
    const why = undated.effective ? undated.effective.reason : "no effective date is on any page in the file";
    return none(`can't tell which report is current: "${undated.report.doc}" ${why}`);
  }
  const sorted = [...dated].sort((a, b) => (backed(b.effective)! < backed(a.effective)! ? -1 : 1));
  const newest = sorted[0]!;
  const effective = backed(newest.effective)!;
  const superseded = sorted.slice(1).map((d) => d.report.doc);
  if (sorted[1] && backed(sorted[1].effective) === effective) return none(`two reports carry the same effective date (${effective})`);

  const age = daysBetween(effective, request.asOf);
  const base = { report: newest.report, effective, superseded };
  if (age === null) return { ...base, decided: false, complete: false, because: `request date ${request.asOf} is not a real day` };
  if (age < 0) return { ...base, decided: false, complete: false, because: `"${newest.report.doc}" is effective ${effective}, after the request date` };
  if (age > policy.maxTitleAgeDays) {
    return { ...base, decided: false, complete: false, because: `"${newest.report.doc}" is ${age} days old on ${request.asOf}; the policy allows ${policy.maxTitleAgeDays}` };
  }

  const doc = docs.find((d) => d.id === newest.report.doc)!;
  const whole = wholeness(doc);
  if (!whole.whole) return { ...base, decided: true, complete: false, because: whole.reason };
  const read = new Set(newest.report.items.map((item) => gateItem(docs, newest.report.doc, item)).filter((item) => item.kind.status === "supported").map((item) => item.number));
  const printed = printedItems(doc);
  const top = Math.max(0, ...printed);
  const unread = Array.from({ length: top }, (_, i) => i + 1).filter((n) => !read.has(n));
  if (unread.length > 0) return { ...base, decided: true, complete: false, because: `Schedule B item ${unread.join(", ")} was not read with a supported kind` };
  return { ...base, decided: true, complete: true, because: `"${newest.report.doc}" (effective ${effective}, ${age} days old, whole, ${top} items read)` };
}

interface StatementFact {
  readonly doc: string;
  readonly date: string;
  readonly original: number;
  readonly balance: number;
}

function currentStatements(docs: readonly Doc[], reading: TitleReading, request: LienRequest, policy: LienPolicy, problems: Problem[]): StatementFact[] {
  return reading.statements.flatMap((s) => {
    const date = s.date ? checkDate(docs, s.date, { doc: s.doc, label: LABELS.statementDate }) : undefined;
    const original = s.original ? checkMoney(docs, s.original, { doc: s.doc, label: LABELS.original }) : undefined;
    const balance = s.balance ? checkMoney(docs, s.balance, { doc: s.doc, label: LABELS.balance }) : undefined;
    for (const c of [date, original, balance]) note(problems, c);
    const d = backed(date);
    const o = backed(original);
    const b = backed(balance);
    if (d === null || o === null || b === null || !balance) return [];
    const age = daysBetween(d, request.asOf);
    if (age === null || age < 0 || age > policy.maxStatementAgeDays) return [];
    if (b > o) {
      problems.push({ field: balance.field, doc: balance.cite.doc, page: balance.cite.page, status: "held", reason: `balance ${dollars(b)} is above the original principal ${dollars(o)}: negative amortization, or a different loan` });
      return [];
    }
    return [{ doc: s.doc, date: d, original: o, balance: b }];
  });
}

function note(problems: Problem[], checked: Checked<unknown> | undefined): void {
  if (checked && checked.status !== "supported") {
    problems.push({ field: checked.field, doc: checked.cite.doc, page: checked.cite.page, status: checked.status, reason: checked.reason ?? "" });
  }
}

/** A statement narrows a lien only when its original principal matches exactly one lien's recorded amount. */
function balanceOf(item: Item, mortgageItems: readonly Item[], statements: readonly StatementFact[], policy: LienPolicy): { balance: Interval; because: string } {
  const label = backed(item.instrument) ?? `item ${item.number}`;
  const amount = backed(item.amount);
  if (amount === null) return { balance: UNBACKED, because: `recorded amount of ${label} is not backed, so no statement can be tied to it` };
  const cents = (n: number | null) => (n === null ? null : Math.round(n * 100));
  const twins = mortgageItems.filter((other) => other !== item && cents(backed(other.amount)) === cents(amount));
  if (twins.length > 0) return { balance: UNBACKED, because: `two liens record ${dollars(amount)}; a statement can't say which it covers` };
  const mine = statements.filter((s) => cents(s.original) === cents(amount));
  if (mine.length === 0) return { balance: UNBACKED, because: `no statement dated within ${policy.maxStatementAgeDays} days matches ${label}'s recorded ${dollars(amount)}` };
  const latest = mine.reduce((a, b) => (b.date > a.date ? b : a)).date;
  const same = mine.filter((s) => s.date === latest);
  const balance = same.map((s) => point(s.balance)).reduce(hull);
  return { balance, because: `statement "${same[0]!.doc}" dated ${latest}` };
}

/**
 * The earliest-recorded lien, ties broken by instrument number; undefined when a date or a tie
 * can't be settled from backed values.
 */
function earliest(liens: readonly Lien[]): Lien | null | undefined {
  const keyed = liens.map((l) => ({ l, date: backed(l.item.recorded), instrument: backed(l.item.instrument) }));
  if (keyed.some((k) => k.date === null)) return undefined;
  const sorted = keyed.sort((a, b) => (a.date === b.date ? (a.instrument ?? "").localeCompare(b.instrument ?? "") : a.date! < b.date! ? -1 : 1));
  const [a, b] = sorted;
  if (!a) return null;
  if (b && a.date === b.date && (a.instrument === null || b.instrument === null)) return undefined;
  return a.l;
}

function rule(id: Check["id"], status: Tri, because: string): Check {
  return { id, status, because };
}

/** No lien matching `bad` may stay on the property. */
function absent(title: TitleState, liens: readonly Lien[], bad: (l: Lien) => boolean, what: string): { status: Tri; because: string } {
  if (!title.decided) return { status: "unknown", because: title.because };
  const sure = liens.find((l) => bad(l) && l.stays === "yes");
  if (sure) return { status: "fail", because: `item ${sure.item.number}: ${what} (${backed(sure.item.instrument) ?? "instrument not backed"})` };
  const maybe = liens.find((l) => bad(l) && l.stays === "maybe");
  if (maybe) return { status: "unknown", because: `item ${maybe.item.number} is ${what}; can't tell whether it is paid at closing` };
  return title.complete ? { status: "pass", because: `none on ${title.because}` } : { status: "unknown", because: `none visible, but ${title.because}` };
}

export function checkTitle(docs: readonly Doc[], reading: TitleReading, request: LienRequest, policy: LienPolicy, file = "file"): LienReport {
  const problems: Problem[] = [];
  const title = titleState(docs, reading, request, policy);
  const report = title.report;
  const items = report ? report.items.map((r) => gateItem(docs, report.doc, r)) : [];
  for (const item of items) for (const c of [item.kind, item.recorded, item.instrument, item.amount, item.holder]) note(problems, c);
  const statements = currentStatements(docs, reading, request, policy, problems);

  const payoff = new Set(request.payoff ?? []);
  const typed = items.filter((item) => item.kind.status === "supported" && item.kind.value !== "other" && item.kind.value !== "property-taxes");
  const mortgageItems = typed.filter((item) => MORTGAGE_KINDS.includes(item.kind.value));
  const liens: Lien[] = typed
    .filter((item) => item.kind.value !== "subordination")
    .map((item) => {
      const instrument = backed(item.instrument);
      const stays: Lien["stays"] =
        payoff.size === 0 || !MORTGAGE_KINDS.includes(item.kind.value) ? "yes" : instrument === null ? "maybe" : payoff.has(instrument) ? "paid-at-closing" : "yes";
      const isMortgage = MORTGAGE_KINDS.includes(item.kind.value);
      const { balance, because } = isMortgage ? balanceOf(item, mortgageItems, statements, policy) : { balance: ZERO, because: "not a mortgage lien; not counted in CLTV" };
      return { item, kind: item.kind.value, stays, balance, balanceBecause: because };
    });
  const mortgages = liens.filter((l) => MORTGAGE_KINDS.includes(l.kind));
  const staying = mortgages.filter((l) => l.stays !== "paid-at-closing");
  const sureStaying = staying.filter((l) => l.stays === "yes");
  const subordination = typed.find((item) => item.kind.value === "subordination");
  const conditions = mortgages
    .filter((l) => l.stays === "paid-at-closing")
    .map((l) => `pay off and reconvey ${backed(l.item.instrument)} at closing; verify the reconveyance records`);
  const listed = new Set(mortgages.map((l) => backed(l.item.instrument)));
  for (const p of payoff) if (!listed.has(p)) conditions.push(`payoff ${p} is not a mortgage lien on the current report`);

  const checks: Check[] = [rule("title", title.complete ? "pass" : "unknown", title.because)];

  const count: Interval = { lo: sureStaying.length, hi: title.complete ? staying.length : Infinity };
  let position = title.decided ? inside(count, 1, 1) : "unknown";
  let positionBecause = title.decided
    ? `${sureStaying.length === 1 ? "one mortgage lien stays" : `${sureStaying.length} mortgage liens stay`} ahead of the new line${title.complete ? "" : `; ${title.because}`}`
    : title.because;
  if (position === "fail" && count.hi < 1) positionBecause = "no first lien of record: the new line would record first";
  if (position === "fail" && count.lo > 1) positionBecause = `${count.lo} mortgage liens stay ahead of the new line: it would record third or later`;
  if (position === "pass" && subordination) {
    position = "unknown";
    positionBecause = `a subordination agreement is recorded (item ${subordination.number}); verify priority before relying on recording order`;
  }
  checks.push(rule("second-position", position, positionBecause));

  const first = title.complete && staying.length === sureStaying.length ? earliest(staying) : undefined;
  const cutoff = monthsBefore(request.asOf, policy.seasoningMonths);
  if (!title.decided) checks.push(rule("first-seasoned", "unknown", title.because));
  else if (first === undefined) {
    const held = staying.find((l) => backed(l.item.recorded) === null);
    checks.push(rule("first-seasoned", "unknown", held ? `item ${held.item.number}'s recording date is not backed: ${held.item.recorded?.reason ?? "not read"}` : `can't tell which lien is first: ${title.because}`));
  } else if (first === null) checks.push(rule("first-seasoned", "fail", "no first lien of record"));
  else {
    const recorded = backed(first.item.recorded)!;
    const ok = cutoff !== null && recorded <= cutoff;
    checks.push(rule("first-seasoned", ok ? "pass" : "fail", `first lien ${backed(first.item.instrument) ?? `item ${first.item.number}`} recorded ${recorded}; must be on or before ${cutoff}`));
  }

  const heloc = absent(title, staying, (l) => l.kind === "credit-line-deed-of-trust", "a line of credit that would stay senior");
  checks.push(rule("no-senior-heloc", heloc.status, heloc.because));
  const taxOrJudgment = absent(title, liens, (l) => l.kind === "tax-lien" || l.kind === "judgment", "a recorded tax lien or judgment");
  checks.push(rule("no-tax-or-judgment", taxOrJudgment.status, taxOrJudgment.because));
  const reverse = absent(title, staying, (l) => l.kind === "reverse-mortgage", "a reverse mortgage");
  checks.push(rule("no-reverse-mortgage", reverse.status, reverse.because));

  const owedOnLiens = title.decided ? add(sum(mortgages.map((l) => l.balance)), title.complete ? ZERO : UNBACKED) : UNBACKED;
  const cltv = percentOf(add(owedOnLiens, request.amount), request.homeValue);
  const cltvStatus = atMost(cltv, request.maxCltv);
  const unbacked = mortgages.filter((l) => l.balance.hi === Infinity).map((l) => l.balanceBecause);
  const cltvWhy =
    cltvStatus === "unknown"
      ? (unbacked[0] ?? title.because)
      : unbacked.length === 0 && title.complete
        ? "every lien balance is backed"
        : "the backed balances already decide it";
  checks.push(rule("cltv", cltvStatus, `${cltvWhy}; limit ${request.maxCltv}%`));

  return {
    file,
    asOf: request.asOf,
    policy: policy.id,
    report: { current: title.report?.doc ?? null, effective: title.effective, superseded: title.superseded },
    liens: liens.map((l) => ({
      item: l.item.number,
      kind: l.kind,
      instrument: backed(l.item.instrument),
      recorded: backed(l.item.recorded),
      amount: backed(l.item.amount),
      holder: backed(l.item.holder),
      stays: l.stays,
      balance: l.balance,
      balanceBecause: l.balanceBecause,
    })),
    problems,
    checks,
    cltv,
    verdict: all(checks.map((c) => c.status)),
    conditions,
    notReadHere: policy.notReadHere,
    heloc: helocFacts(title, mortgages, title.complete ? earliest(mortgages) : undefined),
  };
}

/**
 * The borrower's guess at "Do you have another loan against this home?", replaced by the title.
 * Unknown stays unknown, and an unknown balance is never zero.
 */
function helocFacts(title: TitleState, mortgages: readonly Lien[], first: Lien | null | undefined): HelocFacts {
  if (first === null) return { balance: ZERO, otherLoan: "no", otherBalance: ZERO };
  if (first) {
    const others = mortgages.filter((l) => l !== first);
    return { balance: first.balance, otherLoan: others.length > 0 ? "yes" : "no", otherBalance: sum(others.map((l) => l.balance)) };
  }
  const seen = title.decided ? mortgages.length : 0;
  return { balance: UNBACKED, otherLoan: seen >= 2 ? "yes" : "unknown", otherBalance: UNBACKED };
}
