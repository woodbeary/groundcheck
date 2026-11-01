/**
 * Record a model reader live on one layout's synthetic files:
 *
 *   node scripts/record.ts --live --reader claude-json --layout title-b
 *
 * It calls the Claude API with your own credentials and spends your money. Each file's recording
 * replaces the simulated one; then run `pnpm eval` and, if the numbers are the ones you want to
 * hold, `node src/cli.ts eval --pin`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { layoutFiles, type Layout } from "../src/eval/run.ts";
import { recordLive, sdkSender } from "../src/readers/live.ts";
import { recordingPath } from "../src/readers/recordings.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const reader = arg("--reader");
const layout = arg("--layout") as Layout | undefined;
if (!process.argv.includes("--live") || !reader || !layout) {
  console.error("usage: node scripts/record.ts --live --reader claude-json|claude-citations --layout title-a|title-b");
  process.exit(2);
}
const send = sdkSender();
for (const file of layoutFiles(layout)) {
  const recording = await recordLive(reader, file, send);
  const path = recordingPath(reader, file.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`${file.id}: ${recording.response.stop_reason}`);
}
