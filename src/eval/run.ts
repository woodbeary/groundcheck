/**
 * Runs a title reader over a layout's files and scores it against that layout's key. The
 * reference reader is the pattern reader in this repository; the model readers answer from
 * their recordings (see src/readers/recordings.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFile, type LoanFile } from "../core/file.ts";
import { lienstack, readTitle, type LienReport, type LienRequest } from "../lienstack/index.ts";
import { MODEL_READERS, RECORDINGS, loadRecording, replayReader } from "../readers/recordings.ts";
import { scoreTitle, type TitleKey, type TitleScore } from "./title.ts";

export const EXAMPLES = new URL("../../examples/", import.meta.url).pathname;
export const BASELINE = new URL("../../eval/baseline.json", import.meta.url).pathname;

export const LAYOUTS = { "title-a": "title", "title-b": "title-b" } as const;
export type Layout = keyof typeof LAYOUTS;
export const READERS = ["reference", ...Object.keys(MODEL_READERS)] as const;

/** The pairs scored and pinned: the reference reader on both layouts, the model readers on layout B. */
export const PAIRS: readonly { reader: string; layout: Layout }[] = [
  { reader: "reference", layout: "title-a" },
  { reader: "reference", layout: "title-b" },
  { reader: "claude-json", layout: "title-b" },
  { reader: "claude-citations", layout: "title-b" },
];

export function layoutFiles(layout: Layout): LoanFile<LienRequest>[] {
  const dir = join(EXAMPLES, LAYOUTS[layout]);
  return readdirSync(dir)
    .filter((n) => /^(title|alta)-\d+\.json$/.test(n))
    .sort()
    .map((n) => loadFile<LienRequest>(join(dir, n)));
}

export function layoutKey(layout: Layout): TitleKey {
  return JSON.parse(readFileSync(join(EXAMPLES, LAYOUTS[layout], "key.json"), "utf8")) as TitleKey;
}

export interface Run {
  readonly reader: string;
  readonly layout: Layout;
  readonly reports: readonly LienReport[];
  readonly score: TitleScore;
  /** Where the readings came from: "pattern reader", or the recordings' kinds. */
  readonly responses: string;
}

export function runTitle(reader: string, layout: Layout, dir = RECORDINGS): Run {
  const files = layoutFiles(layout);
  const reports = files.map((f) => lienstack(f, reader === "reference" ? readTitle : replayReader(reader, f, dir)));
  const kinds = reader === "reference" ? ["pattern reader"] : [...new Set(files.map((f) => loadRecording(reader, f.id, dir)?.kind ?? "missing"))].sort();
  return { reader, layout, reports, score: scoreTitle(reports, layoutKey(layout)), responses: kinds.join(", ") };
}

export interface Pinned {
  readonly note: string;
  readonly entries: Readonly<Record<string, TitleScore & { readonly responses: string }>>;
}

export const pairId = (reader: string, layout: Layout) => `${reader}@${layout}`;
