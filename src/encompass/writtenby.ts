/**
 * Who wrote each loan field, from Encompass's enhancedfieldchange webhook: the event carries each
 * field's previous and new value and meta.userId (reference/wbhks-re-cat-loan, checked
 * 2026-11-01). The connector logs that as writtenBy and never overwrites it. A processor's value
 * that differs from what was staged is the one signal that the reading was wrong, so it becomes a
 * golden-set entry, the way the December 2025 demo's "Bad Output" button did.
 */

import type { LoanEvent } from "./mock.ts";

export interface FieldWrite {
  readonly loan: string;
  readonly field: string;
  readonly previousValue: string;
  readonly newValue: string;
  readonly writtenBy: string;
  readonly at: string;
}

interface FieldChangePayload {
  readonly event?: { readonly fieldChangeEvents?: readonly { readonly modifiedField: string; readonly encompass?: { readonly previousValue?: string; readonly newValue?: string } }[] };
}

export function fieldWrites(event: LoanEvent): FieldWrite[] {
  if (event.eventType !== "enhancedfieldchange") return [];
  const changes = (event.meta.payload as FieldChangePayload | undefined)?.event?.fieldChangeEvents ?? [];
  return changes.map((c) => ({ loan: event.meta.resourceId, field: c.modifiedField, previousValue: c.encompass?.previousValue ?? "", newValue: c.encompass?.newValue ?? "", writtenBy: event.meta.userId, at: event.eventTime }));
}

export interface GoldenEntry {
  readonly loan: string;
  readonly field: string;
  readonly staged: string;
  readonly processorValue: string;
  readonly writtenBy: string;
  readonly source: string;
  readonly label: "processor edit differs from staged value";
}

/** Processor writes to a target field that disagree with the staged value: labels the reader didn't write. */
export function goldenEntries(writes: readonly FieldWrite[], staged: Readonly<Record<string, { readonly value: string; readonly source: string }>>, connectorUser: string): GoldenEntry[] {
  return writes
    .filter((w) => w.writtenBy !== connectorUser && staged[w.field] && staged[w.field]!.value !== w.newValue)
    .map((w) => ({ loan: w.loan, field: w.field, staged: staged[w.field]!.value, processorValue: w.newValue, writtenBy: w.writtenBy, source: staged[w.field]!.source, label: "processor edit differs from staged value" }));
}
