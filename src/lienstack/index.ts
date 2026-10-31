import type { LoanFile } from "../core/file.ts";
import { checkTitle } from "./check.ts";
import { SECOND_LIEN_PUBLIC } from "./policy.ts";
import { readTitle } from "./read.ts";
import type { LienPolicy, LienReport, LienRequest, TitleReader } from "./types.ts";

export { checkTitle } from "./check.ts";
export { SECOND_LIEN_PUBLIC } from "./policy.ts";
export { readTitle } from "./read.ts";
export { MORTGAGE_KINDS, kindOf } from "./types.ts";
export type * from "./types.ts";

export function lienstack(file: LoanFile<LienRequest>, reader: TitleReader = readTitle, policy: LienPolicy = SECOND_LIEN_PUBLIC): LienReport {
  return checkTitle(file.docs, reader(file.docs), file.request, policy, file.id);
}
