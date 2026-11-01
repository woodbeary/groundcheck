/**
 * Recording a model reader live. This is the only code that calls a model, and nothing in the
 * test suite or CI runs it against the API: it needs the person's own credentials (the SDK reads
 * ANTHROPIC_API_KEY or an `ant auth login` profile), runs on synthetic files only, and spends
 * their money. The Anthropic SDK is an optional dependency, loaded only here.
 *
 * A response served by a different model than the one asked for is not saved: a reader's score
 * belongs to one model. No server-side fallback is requested for the same reason, and a refusal
 * is recorded as it is, to be scored as no reading.
 */

import type { LoanFile } from "../core/file.ts";
import type { MessageResponse } from "./claude-json.ts";
import { MODEL_READERS, type Recording } from "./recordings.ts";

export type Send = (body: Record<string, unknown>) => Promise<MessageResponse>;

/** Send through the official SDK. `baseURL` and `apiKey` are for pointing it at a local stand-in in tests. */
export function sdkSender(options: { readonly baseURL?: string; readonly apiKey?: string } = {}): Send {
  return async (body) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic(options);
    const message = await client.messages.create(body as unknown as Parameters<typeof client.messages.create>[0] & { stream?: false });
    return message as unknown as MessageResponse;
  };
}

export async function recordLive(readerName: string, file: LoanFile<unknown>, send: Send, at = new Date().toISOString()): Promise<Recording> {
  const reader = MODEL_READERS[readerName];
  if (!reader) throw new Error(`no model reader named ${readerName}`);
  if (file.synthetic !== true) throw new Error(`${file.id}: only synthetic files are recorded`);
  const request = reader.build(file.docs);
  const response = await send(request);
  const asked = (request as { model: string }).model;
  if (response.model !== asked) throw new Error(`${file.id}: ${response.model ?? "an unnamed model"} answered, not ${asked}; not saved`);
  return { reader: readerName, file: file.id, kind: "live", promptSha: reader.promptSha, fileSha256: file.sha256, recordedAt: at, request, response };
}
