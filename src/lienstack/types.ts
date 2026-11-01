import type { Claim, Doc } from "../core/evidence.ts";
import type { Interval, Tri } from "../core/interval.ts";

export type LienKind =
  | "deed-of-trust"
  | "credit-line-deed-of-trust"
  | "reverse-mortgage"
  | "tax-lien"
  | "judgment"
  | "subordination"
  | "property-taxes"
  | "other-lien"
  | "other";

export const MORTGAGE_KINDS: readonly LienKind[] = ["deed-of-trust", "credit-line-deed-of-trust", "reverse-mortgage"];

/**
 * What a Schedule B item is, decided from its printed text. Order matters: a reverse mortgage and
 * a subordination agreement both mention a deed of trust, covenants often mention "the lien of any
 * deed of trust" without being one, and the coming year's property taxes are printed as "a lien not
 * yet due or payable", which is not the recorded tax lien the rules mean. A lien none of the rules
 * name (a mechanic's lien, an association lien, a lis pendens) is "other-lien", never "other";
 * the printed exception for liens "not shown by the public records" is not a recorded lien.
 */
export function kindOf(text: string): LienKind {
  const t = text.toLowerCase();
  const lead = t.replace(/^\s*\d{1,2}\.\s*/, "").replace(/^(?:an?|the)\s+/, "");
  if (/^(?:easements?|covenants|conditions and restrictions|restrictions)\b/.test(lead) || /not shown by the public records/.test(t)) return "other";
  if (/\btaxes\b/.test(t) && /not yet due/.test(t)) return "property-taxes";
  if (/subordination agreement/.test(t)) return "subordination";
  if (/home equity conversion|reverse mortgage/.test(t)) return "reverse-mortgage";
  if (/tax lien/.test(t)) return "tax-lien";
  if (/abstract of judgment|\bjudgment\b/.test(t)) return "judgment";
  if (/deed of trust|\bmortgage\b/.test(t)) return /line of credit|credit line|revolving/.test(t) ? "credit-line-deed-of-trust" : "deed-of-trust";
  if (/\bliens?\b|lis pendens|pendency of action/.test(t)) return "other-lien";
  return "other";
}

/** One numbered Schedule B item as a reader proposes it. */
export interface ItemReading {
  readonly number: number;
  readonly kind: Claim<LienKind>;
  readonly recorded?: Claim<string>;
  readonly instrument?: Claim<string>;
  readonly amount?: Claim<number>;
  readonly holder?: Claim<string>;
}

export interface ReportReading {
  readonly doc: string;
  readonly effective?: Claim<string>;
  readonly items: readonly ItemReading[];
}

export interface StatementReading {
  readonly doc: string;
  readonly date?: Claim<string>;
  readonly original?: Claim<number>;
  readonly balance?: Claim<number>;
}

export interface TitleReading {
  readonly reports: readonly ReportReading[];
  readonly statements: readonly StatementReading[];
}

/** Anything that reads a title file: the reference reader here, a model, or a vendor extractor. */
export type TitleReader = (docs: readonly Doc[]) => TitleReading;

export interface LienRequest {
  /** The day the check runs (UTC). Every date is judged against it. */
  readonly asOf: string;
  readonly homeValue: Interval;
  /** Cash the new line must provide, before any payoff it also has to cover. */
  readonly amount: Interval;
  /** The program's combined loan-to-value ceiling for this borrower's tier, in percent. */
  readonly maxCltv: number;
  /** Instrument numbers the new line pays off at closing. */
  readonly payoff?: readonly string[];
}

export interface LienPolicy {
  readonly id: string;
  readonly source: string;
  readonly seasoningMonths: number;
  readonly maxTitleAgeDays: number;
  readonly maxStatementAgeDays: number;
  /** Conditions the source prints that a title report and a statement can't show. Never passed here. */
  readonly notReadHere: readonly string[];
}

export type RuleId = "title" | "second-position" | "first-seasoned" | "no-senior-heloc" | "no-tax-or-judgment" | "no-reverse-mortgage" | "no-unrated-lien" | "cltv";

export interface Check {
  readonly id: RuleId;
  readonly status: Tri;
  readonly because: string;
}

export interface LienView {
  readonly item: number;
  readonly kind: LienKind;
  readonly instrument: string | null;
  readonly recorded: string | null;
  readonly amount: number | null;
  readonly holder: string | null;
  readonly stays: "yes" | "paid-at-closing" | "maybe";
  readonly balance: Interval;
  readonly balanceBecause: string;
}

export interface Problem {
  readonly field: string;
  readonly doc: string;
  readonly page: number;
  readonly status: "held" | "unsupported";
  readonly reason: string;
}

/** The same three facts the HELOC engine asks the borrower for, read from the title instead. */
export interface HelocFacts {
  readonly balance: Interval;
  readonly otherLoan: "no" | "yes" | "unknown";
  readonly otherBalance: Interval;
}

export interface LienReport {
  readonly file: string;
  /** SHA-256 of the input file. */
  readonly sha256: string;
  readonly asOf: string;
  readonly policy: string;
  readonly report: { readonly current: string | null; readonly effective: string | null; readonly superseded: readonly string[] };
  readonly liens: readonly LienView[];
  readonly problems: readonly Problem[];
  readonly checks: readonly Check[];
  readonly cltv: Interval;
  readonly verdict: Tri;
  readonly conditions: readonly string[];
  readonly notReadHere: readonly string[];
  readonly heloc: HelocFacts;
}
