import type { Claim, Doc, Page } from "../core/evidence.ts";
import type { Interval, Tri } from "../core/interval.ts";

/** The seven page classes from the December 2025 router. UNCERTAIN goes to a person. */
export const PAGE_CLASSES = ["RENT_SCHEDULE", "COVER_SHEET", "LEGAL_DOCUMENT", "FINANCIAL_DATA", "PROPERTY_INFO", "IRRELEVANT", "UNCERTAIN"] as const;
export type PageClass = (typeof PAGE_CLASSES)[number];

export interface Routed {
  readonly doc: string;
  readonly page: number;
  readonly cls: PageClass;
  readonly confidence: number;
}

/** Anything that labels a page: the reference router here, a model, or a vendor classifier. */
export type Router = (page: Page) => { cls: Exclude<PageClass, "UNCERTAIN">; confidence: number };

/** What an "Association Dues:" line says, as code reads it. */
export type DuesLine = "none" | "dues";

export interface AppraisalReading {
  readonly doc: string;
  readonly effective?: Claim<string>;
  readonly marketRent?: Claim<number>;
  /** The page prints that the property pays no association dues. */
  readonly noDues?: Claim<DuesLine>;
}

export interface LeaseReading {
  readonly doc: string;
  readonly rent?: Claim<number>;
  readonly start?: Claim<string>;
  readonly end?: Claim<string>;
}

export interface NoteReading {
  readonly doc: string;
  readonly principal?: Claim<number>;
  readonly rate?: Claim<number>;
  readonly termMonths?: Claim<number>;
  readonly payment?: Claim<number>;
}

/** A tax bill or an insurance declarations page: an annual amount and the period it covers. */
export interface PeriodReading {
  readonly doc: string;
  readonly from?: Claim<string>;
  readonly to?: Claim<string>;
  readonly annual?: Claim<number>;
}

export interface DuesReading {
  readonly doc: string;
  readonly date?: Claim<string>;
  readonly monthly?: Claim<number>;
}

export interface DscrReading {
  readonly appraisals: readonly AppraisalReading[];
  readonly leases: readonly LeaseReading[];
  readonly notes: readonly NoteReading[];
  readonly taxBills: readonly PeriodReading[];
  readonly insurance: readonly PeriodReading[];
  readonly dues: readonly DuesReading[];
}

/** Reads only the pages a router sent it, and only proposes. */
export type DscrReader = (docs: readonly Doc[], routed: readonly Routed[]) => DscrReading;

export interface DscrRequest {
  readonly asOf: string;
}

export interface DscrPolicy {
  readonly id: string;
  /** A page the router is less sure of than this goes to a person instead of the reader. */
  readonly routerFloor: number;
  readonly maxAppraisalAgeDays: number;
  readonly maxDuesStatementAgeDays: number;
}

/** A program's DSCR floor. The ones in this repository are fictional. */
export interface Overlay {
  readonly id: string;
  readonly name: string;
  readonly minDscr: number;
}

export type Component = "lease rent" | "market rent" | "principal and interest" | "taxes" | "insurance" | "association dues";

export interface Part {
  readonly name: Component;
  /** Monthly dollars. */
  readonly value: Interval;
  readonly because: string;
}

export interface Problem {
  readonly field: string;
  readonly doc: string;
  readonly page: number;
  readonly status: "held" | "unsupported";
  readonly reason: string;
}

/** Every proposed value and what the gate made of it, before any cross-check. */
export interface GatedClaim {
  readonly field: string;
  readonly doc: string;
  readonly page: number;
  readonly status: "supported" | "held" | "unsupported";
  readonly value: unknown;
}

export interface DscrReport {
  readonly file: string;
  /** SHA-256 of the input file. */
  readonly sha256: string;
  readonly asOf: string;
  readonly policy: string;
  readonly routed: readonly Routed[];
  /** Pages a person has to look at: counted, never silently dropped. */
  readonly review: readonly Routed[];
  readonly parts: readonly Part[];
  readonly rent: Interval;
  readonly pitia: Interval;
  readonly dscr: Interval;
  readonly overlays: readonly { readonly overlay: Overlay; readonly status: Tri }[];
  /** For a result that can't tell: each fact that isn't pinned down, and why. */
  readonly needs: readonly string[];
  readonly problems: readonly Problem[];
  readonly claims: readonly GatedClaim[];
}
