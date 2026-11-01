/**
 * Model readers replayed from recordings, so CI scores them with no key and no network. A
 * recording holds the exact request a reader built and the response it got. Replay rebuilds the
 * request from the current code and file and refuses a recording that no longer matches it: a
 * changed prompt, schema, mask or file has to be recorded again, never scored on an old answer.
 *
 * A recording's `kind` says where its response came from: "live" from the API, or "simulated",
 * written by scripts/simulate.ts in the documented response shape to exercise the parser, the
 * gate and the eval. A simulated response is not a model's output, and the eval says so.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../core/evidence.ts";
import type { LoanFile } from "../core/file.ts";
import type { TitleReader, TitleReading } from "../lienstack/types.ts";
import * as citations from "./claude-citations.ts";
import * as json from "./claude-json.ts";
import { fromProposals, type Proposal } from "./proposals.ts";

export interface ModelReader {
  readonly name: string;
  readonly promptSha: string;
  build(docs: readonly Doc[]): Record<string, unknown>;
  parse(response: json.MessageResponse, docs: readonly Doc[]): { proposals: Proposal[] } | { noReading: string };
}

export const MODEL_READERS: Readonly<Record<string, ModelReader>> = {
  "claude-json": { name: "claude-json", promptSha: json.PROMPT_SHA, build: json.buildRequest, parse: (r) => json.parseResponse(r) },
  "claude-citations": { name: "claude-citations", promptSha: citations.PROMPT_SHA, build: citations.buildRequest, parse: citations.parseResponse },
};

export interface Recording {
  readonly reader: string;
  readonly file: string;
  readonly kind: "live" | "simulated";
  readonly promptSha: string;
  readonly fileSha256: string;
  readonly recordedAt: string;
  readonly note?: string;
  readonly request: Record<string, unknown>;
  readonly response: json.MessageResponse;
}

export const RECORDINGS = new URL("../../recordings/", import.meta.url).pathname;

export function recordingPath(reader: string, file: string, dir = RECORDINGS): string {
  return join(dir, reader, `${file}.json`);
}

export function loadRecording(reader: string, file: string, dir = RECORDINGS): Recording | null {
  const path = recordingPath(reader, file, dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Recording) : null;
}

/** Why a recording can't be replayed against this file and this code, or null when it can. */
export function stale(recording: Recording, reader: ModelReader, file: LoanFile<unknown>): string | null {
  if (recording.reader !== reader.name) return `recording is for reader ${recording.reader}, not ${reader.name}`;
  if (recording.promptSha !== reader.promptSha) return `recording was made with prompt ${recording.promptSha.slice(0, 12)}, the reader now sends ${reader.promptSha.slice(0, 12)}; record it again`;
  if (JSON.stringify(recording.request) !== JSON.stringify(reader.build(file.docs))) return `the request this reader builds for ${file.id} has changed since it was recorded; record it again`;
  const model = (recording.request as { model?: string }).model;
  if (recording.response.model !== undefined && recording.response.model !== model) return `the response came from ${recording.response.model}, not the ${model} that was asked; a fallback model is not this reader`;
  return null;
}

/** A reader for one file that answers from its recording. A missing recording is no reading; a stale one throws. */
export function replayReader(name: string, file: LoanFile<unknown>, dir = RECORDINGS): TitleReader {
  const reader = MODEL_READERS[name];
  if (!reader) throw new Error(`no model reader named ${name}`);
  return (docs): TitleReading => {
    const recording = loadRecording(name, file.id, dir);
    if (!recording) return fromProposals([], `no ${name} recording for ${file.id}`);
    const why = stale(recording, reader, file);
    if (why) throw new Error(`${name} ${file.id}: ${why}`);
    const parsed = reader.parse(recording.response, docs);
    return "noReading" in parsed ? fromProposals([], parsed.noReading) : fromProposals(parsed.proposals);
  };
}
