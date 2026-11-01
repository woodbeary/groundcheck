import type { LoanFile } from "../core/file.ts";
import { checkDscr } from "./check.ts";
import { EXAMPLE_POLICY, OVERLAYS } from "./policy.ts";
import { readDscr } from "./read.ts";
import { keywordRouter, route } from "./route.ts";
import type { DscrPolicy, DscrReader, DscrReport, DscrRequest, Overlay, Router } from "./types.ts";

export { amortizedPayment, checkDscr } from "./check.ts";
export { EXAMPLE_POLICY, OVERLAYS } from "./policy.ts";
export { readDscr } from "./read.ts";
export { READABLE, keywordRouter, route } from "./route.ts";
export { PAGE_CLASSES } from "./types.ts";
export type * from "./types.ts";

export interface DscrOptions {
  readonly router?: Router;
  readonly reader?: DscrReader;
  readonly policy?: DscrPolicy;
  readonly overlays?: readonly Overlay[];
}

export function dscrCheck(file: LoanFile<DscrRequest>, options: DscrOptions = {}): DscrReport {
  const policy = options.policy ?? EXAMPLE_POLICY;
  const routed = route(file.docs, options.router ?? keywordRouter, policy.routerFloor);
  const reading = (options.reader ?? readDscr)(file.docs, routed);
  return checkDscr(file.docs, routed, reading, file.request, policy, options.overlays ?? OVERLAYS, file.id);
}
