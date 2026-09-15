import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

type Payload = Record<string, unknown>;

/**
 * Recover DeepSeek chain-of-thought from a Responses wire stream.
 *
 * DeepSeek's Responses API returns thinking as a `reasoning` output item whose
 * `content` holds `reasoning_text` parts, streamed as
 * `response.reasoning_text.delta` / `response.reasoning_text.done`
 * (https://api-docs.deepseek.com/guides/responses_api/, `create-response`).
 * `@ai-sdk/openai` only models the OpenAI `summary_text` flavor
 * (`response.reasoning_summary_*`), so a DeepSeek stream still produces
 * `reasoning-start` / `reasoning-end` but with empty text: the whole
 * chain-of-thought is dropped before the agent loop can surface it.
 *
 * The adapter forwards the untouched SSE payload as `raw` stream parts, so this
 * middleware replays the DeepSeek-specific events as reasoning deltas under the
 * same part id the adapter opened (`${item_id}:0`). OpenAI-native streams carry
 * `summary_text`, which is already mapped, so they pass through untouched.
 */
export function applyResponsesReasoningMiddleware(
  model: LanguageModelV4,
): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      // Recovery reads `raw` stream parts, so request them even when the caller
      // did not opt in. The flag is adapter-side only and never hits the wire.
      transformParams: async ({ params }) =>
        params.includeRawChunks === true
          ? params
          : { ...params, includeRawChunks: true },
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        return { ...rest, stream: stream.pipeThrough(createReasoningRecoveryTransform()) };
      },
    },
  });
}

interface ReasoningPartState {
  /** The adapter never opened this part, so this middleware must close it. */
  selfOpened: boolean;
  /** Plain text already replayed as reasoning deltas. */
  emitted: string;
}

function createReasoningRecoveryTransform(): TransformStream<
  LanguageModelV4StreamPart,
  LanguageModelV4StreamPart
> {
  const parts = new Map<string, ReasoningPartState>();

  return new TransformStream({
    transform(part, controller) {
      controller.enqueue(part);
      if (part.type !== "raw") return;

      const payload = asRecord(part.rawValue);
      const type = asString(payload?.type);
      if (!payload || !type) return;

      if (type === "response.output_item.added") {
        const item = asRecord(payload.item);
        if (item?.type !== "reasoning") return;
        const id = reasoningPartId(asString(item.id));
        // The adapter opens `reasoning-start` for this item right after the raw
        // chunk, so the part is known-good even before the first delta.
        if (id) parts.set(id, { selfOpened: false, emitted: "" });
        return;
      }

      if (type === "response.reasoning_text.delta") {
        const id = reasoningPartId(asString(payload.item_id));
        const delta = asString(payload.delta);
        if (!id || !delta) return;
        appendDelta(controller, parts, id, delta);
        return;
      }

      // A short chain-of-thought can arrive only as the trailing full text.
      if (type === "response.reasoning_text.done") {
        const id = reasoningPartId(asString(payload.item_id));
        const text = asString(payload.text);
        if (!id || !text) return;
        const state = parts.get(id);
        if (state && state.emitted.length > 0) return;
        const missing = text.slice(state?.emitted.length ?? 0);
        if (missing) appendDelta(controller, parts, id, missing);
        return;
      }

      if (type === "response.output_item.done") {
        const item = asRecord(payload.item);
        if (item?.type !== "reasoning") return;
        const id = reasoningPartId(asString(item.id));
        if (!id) return;
        const state = parts.get(id);
        // Streaming was silent (no deltas): replay the completed item content.
        if (state && state.emitted.length === 0) {
          const text = reasoningTextOf(item);
          if (text) appendDelta(controller, parts, id, text);
        }
        // The adapter closes the part itself for this item.
        parts.delete(id);
      }
    },
    flush(controller) {
      for (const [id, state] of parts) {
        if (state.selfOpened) controller.enqueue({ type: "reasoning-end", id });
      }
      parts.clear();
    },
  });
}

function appendDelta(
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  parts: Map<string, ReasoningPartState>,
  id: string,
  delta: string,
): void {
  const state = parts.get(id);
  if (!state) {
    // Defensive: DeepSeek streamed reasoning text for an item the adapter never
    // announced. Open and close the part here so deltas are never orphaned.
    parts.set(id, { selfOpened: true, emitted: delta });
    controller.enqueue({ type: "reasoning-start", id });
    controller.enqueue({ type: "reasoning-delta", id, delta });
    return;
  }
  state.emitted += delta;
  controller.enqueue({ type: "reasoning-delta", id, delta });
}

function reasoningPartId(itemId: string | undefined): string | null {
  return itemId ? `${itemId}:0` : null;
}

/** Join the `reasoning_text` parts of a `reasoning` output item. */
function reasoningTextOf(item: Payload): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "reasoning_text" ? asString(record.text) ?? "" : "";
    })
    .join("");
}

function asRecord(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
