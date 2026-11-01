/**
 * The processor's review form, as an ICE Secure Scripting Framework guest. The guest reaches the
 * loan only through scripting objects: `elli.script.getObject("loan")`, then `getField`,
 * `setFields` and `commit()` (docs/the-ellie-mae-scripting-framework and
 * docs/ellie-mae-scripting-objects-reference, checked 2026-11-01). Accept writes the staged value
 * into the loan field and commits in the processor's own session, so the save is theirs.
 *
 * The form's logic is here with no UI framework; `stubElli` stands in for `elli.script` in tests
 * and in a local harness. The target field ids come from the lender's admin: this repository
 * doesn't name Encompass field ids it hasn't been given, and the tests use synthetic ones.
 */

import type { EncompassApi } from "./mock.ts";
import { STAGED } from "./staging.ts";

export interface LoanObject {
  getField(id: string): Promise<string>;
  setFields(values: Readonly<Record<string, string>>): Promise<void>;
  commit(): Promise<void>;
}

export interface ElliScript {
  getObject(name: "loan"): Promise<LoanObject>;
}

/** Staged field to the loan field a processor may accept it into, as the lender's admin maps them. */
export type Targets = Readonly<Record<string, string>>;

export interface ReviewRow {
  readonly staged: string;
  readonly target: string;
  readonly stagedValue: string;
  readonly currentValue: string;
  readonly source: string;
  readonly differs: boolean;
}

export class ReviewForm {
  readonly elli: ElliScript;
  readonly targets: Targets;

  constructor(elli: ElliScript, targets: Targets) {
    this.elli = elli;
    this.targets = targets;
  }

  /** Each staged value beside the loan's current value and where the staged one came from. */
  async rows(): Promise<ReviewRow[]> {
    const loan = await this.elli.getObject("loan");
    const source = await loan.getField(STAGED.source);
    const rows: ReviewRow[] = [];
    for (const [staged, target] of Object.entries(this.targets)) {
      const stagedValue = await loan.getField(staged);
      const currentValue = await loan.getField(target);
      rows.push({ staged, target, stagedValue, currentValue, source, differs: stagedValue !== currentValue });
    }
    return rows;
  }

  /** The processor accepts the staged value: it goes into the loan field, under their session. */
  async accept(staged: string): Promise<void> {
    const target = this.targets[staged];
    if (!target) throw new Error(`${staged} has no target field`);
    const loan = await this.elli.getObject("loan");
    const value = await loan.getField(staged);
    if (!value) throw new Error(`${staged} is blank: there is nothing to accept`);
    await loan.setFields({ [target]: value, [STAGED.status]: "Reviewed" });
    await loan.commit();
  }

  /** The processor keeps what the loan already says; only the review status changes. */
  async keep(): Promise<void> {
    const loan = await this.elli.getObject("loan");
    await loan.setFields({ [STAGED.status]: "Reviewed" });
    await loan.commit();
  }
}

/**
 * A premilestoneComplete check. On the web the guest must answer within 1 second, so it reads
 * only state the form already holds and never calls a service. An admin's milestone completion
 * rule on CX.ED.STATUS is the sturdier place for this.
 */
export function premilestoneComplete(state: { readonly status: string }): { readonly allow: boolean; readonly message?: string } {
  return state.status === "Reviewed" ? { allow: true } : { allow: false, message: "Review the staged DSCR values (CX.ED.STATUS is not Reviewed)." };
}

/** elli.script for a harness or a test: the loan object writes through the mock as `userId`, on commit. */
export function stubElli(api: EncompassApi, loanId: string, userId: string): ElliScript & { readonly commits: number } {
  let pending: Record<string, string> = {};
  const state = { commits: 0 };
  const loan: LoanObject = {
    async getField(id) {
      return pending[id] ?? (await api.getFields(loanId, [id]))[id] ?? "";
    },
    async setFields(values) {
      pending = { ...pending, ...values };
    },
    async commit() {
      const values = pending;
      pending = {};
      state.commits += 1;
      await api.setFields(loanId, values, userId);
    },
  };
  return {
    getObject: async () => loan,
    get commits() {
      return state.commits;
    },
  };
}
