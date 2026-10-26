import { randomUUID } from "node:crypto";
import { decode, runtimeClient } from "./sidecar/runtime-repository.js";

/**
 * The sidecar client and the Rust transport both reject a frame above 1 MiB,
 * while a near-budget provider prompt is several MiB of JSON. Measurement is
 * therefore split into wire-bounded groups so the complete prompt never has to
 * cross the IPC as a single frame.
 */
export const MEASURE_FRAME_BUDGET_BYTES = 768 * 1024;
/** JSON wrapper, history envelope and protobuf framing around one payload. */
const MEASURE_ENVELOPE_BYTES = 4 * 1024;
/** Rust charges this once per request, on top of its per-message costs. */
const MEASURE_REQUEST_TOKENS = 3;

const MEDIA_TYPES = new Set(["image", "file", "document", "audio", "video", "attachment", "image_url", "input_image", "output_image", "input_file", "input_audio", "image-data", "file-data", "file-url"]);
/** Same text-accounting projection as Rust. Never send a Uint8Array payload
 * through history IPC just to count the surrounding text. */
function accountingProjection(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if ("type" in value && MEDIA_TYPES.has(String(value.type))) return { type: "retained-attachment" };
  if (Array.isArray(value)) return value.map(accountingProjection);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, accountingProjection(item)]));
}

export interface ContextMeasureInput {
  sessionId: string;
  systemPrompt: string;
  tools: unknown[];
  prompt: unknown[];
  signal?: AbortSignal;
  /** Smaller wire budget for tests; production callers use the default. */
  frameBudgetBytes?: number;
}

/** One `context_measure` request: accounting-projected messages plus tools. */
export type MeasureGroup = { prompt: unknown[]; tools: unknown[] };
type Composition = { system: number; messages: number; tools: number };

/**
 * Split a provider prompt into payloads that each fit one IPC frame. Messages
 * stay intact, so Rust's per-message accounting is never applied to a fragment.
 * Only the first group carries the system prompt and the tool schemas.
 */
export function measureGroups(
  input: Pick<ContextMeasureInput, "systemPrompt" | "tools">,
  prompt: unknown[],
  frameBudgetBytes = MEASURE_FRAME_BUDGET_BYTES,
): MeasureGroup[] {
  const groups: MeasureGroup[] = [];
  let group: MeasureGroup = { prompt: [{ role: "system", content: input.systemPrompt }], tools: input.tools ?? [] };
  let bytes = Buffer.byteLength(JSON.stringify(input.systemPrompt)) +
    Buffer.byteLength(JSON.stringify(input.tools ?? [])) + MEASURE_ENVELOPE_BYTES;
  for (const message of prompt) {
    const projected = accountingProjection(message);
    const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
    // One message is indivisible: only the system prompt shares the first frame.
    if (group.prompt.length > 1 && bytes + size > frameBudgetBytes) {
      groups.push(group);
      group = { prompt: [], tools: [] };
      bytes = MEASURE_ENVELOPE_BYTES;
    }
    group.prompt.push(projected);
    bytes += size;
  }
  groups.push(group);
  return groups;
}

/**
 * Count the exact composition the provider would receive. Rust scores every
 * message independently (`+4` per message) and charges its request base once,
 * so the per-group compositions add up to the single-request total.
 */
export async function measureContextPrompt(input: ContextMeasureInput): Promise<number> {
  let system = 0;
  let messages = 0;
  let tools = 0;
  let first = true;
  for (const group of measureGroups(input, input.prompt, input.frameBudgetBytes)) {
    input.signal?.throwIfAborted();
    const measured = decode<Composition>(await runtimeClient().historyCommand({
      sessionId: input.sessionId, requestId: randomUUID(), operation: "context_measure",
      payload: { prompt: group.prompt, tools: group.tools },
    }));
    if (first) {
      tools = measured.tools;
      first = false;
    }
    system += measured.system;
    messages += measured.messages;
  }
  input.signal?.throwIfAborted();
  return system + messages + tools + MEASURE_REQUEST_TOKENS;
}
