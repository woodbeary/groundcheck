import type { DscrPolicy, Overlay } from "./types.ts";

/** Example settings for this repository, not any program's numbers. Set them to the program's own. */
export const EXAMPLE_POLICY: DscrPolicy = {
  id: "example-dscr",
  routerFloor: 0.6,
  maxAppraisalAgeDays: 120,
  maxDuesStatementAgeDays: 60,
};

/** Fictional overlays. Real programs print their own floor, and some print other rent rules. */
export const OVERLAYS: readonly Overlay[] = [
  { id: "overlay-a", name: "Overlay A (fictional)", minDscr: 1.25 },
  { id: "overlay-b", name: "Overlay B (fictional)", minDscr: 1.0 },
];
