import type { LienPolicy } from "./types.ts";

/**
 * Lien conditions printed in a public second-lien HELOC underwriting guide (rev. 2025-01-22,
 * pp. 6-8): second lien only, behind a first lien seasoned at least 12 months; no existing senior
 * HELOC, tax or judgment lien, or reverse mortgage. Priority, subordination and payoffs are
 * verified, not assumed.
 *
 * The two age limits are example settings for this repository, not numbers from that guide. Set
 * them to the program's own.
 */
export const SECOND_LIEN_PUBLIC: LienPolicy = {
  id: "second-lien-public",
  source: "Public second-lien HELOC guide (rev. 2025-01-22, pp. 6-8); age limits are example settings",
  seasoningMonths: 12,
  maxTitleAgeDays: 60,
  maxStatementAgeDays: 60,
  notReadHere: [
    "active forbearance or deferment on the first lien",
    "negative amortization or a balloon on the first lien",
    "a privately held first lien",
    "ownership and vesting held 12 months",
  ],
};
