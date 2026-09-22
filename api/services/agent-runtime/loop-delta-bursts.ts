import type { LoopModelStreamEvent } from "./contracts.js";
import { AgentRuntimeError } from "./runtime-errors.js";

const BURST_BYTES = 8192,
  BURST_EVENTS = 64,
  BURST_MS = 20,
  INPUT_BYTES = 65536,
  PROCESS_BYTES = 8 * 1024 * 1024;
let reservedBytes = 0;
type Delta = Extract<
  LoopModelStreamEvent,
  { type: "text_delta" | "thought_delta" }
>;
type Next =
  | { kind: "next"; value: IteratorResult<LoopModelStreamEvent> }
  | { kind: "error"; error: unknown };
function reserve(bytes: number): void {
  if (reservedBytes + bytes > PROCESS_BYTES)
    throw new AgentRuntimeError(
      "Native stream batch memory budget exceeded.",
      "STREAM_BACKPRESSURE",
      429,
    );
  reservedBytes += bytes;
}
function deltaEnd(value: string, start: number, limit: number): number {
  let end = Math.min(value.length, start + limit);
  for (;;) {
    if (
      end < value.length &&
      end > start &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end--;
    if (end === start) return start;
    const bytes = Buffer.byteLength(value.slice(start, end));
    if (bytes <= limit) return end;
    end =
      start +
      Math.min(end - start - 1, Math.floor(((end - start) * limit) / bytes));
  }
}

/** Coalesce only display deltas before their durable event write. Native protocol
 * parts and control/retry/usage events are untouched. One upstream read at a time;
 * factory MUST honor cancellation so a prefetched read cannot pin a stopped step. */
export async function* coalesceLoopDeltas(
  factory: (signal: AbortSignal) => AsyncIterable<LoopModelStreamEvent>,
  parentSignal?: AbortSignal,
): AsyncGenerator<LoopModelStreamEvent, void, unknown> {
  const cancellation = new AbortController(),
    signal = parentSignal
      ? AbortSignal.any([parentSignal, cancellation.signal])
      : cancellation.signal;
  let iterator: AsyncIterator<LoopModelStreamEvent> | undefined,
    pending: Promise<Next> | undefined,
    buffer: Delta | undefined,
    bufferBytes = 0,
    events = 0,
    deadline = 0,
    completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function drain(): Delta {
    const value = buffer!;
    reservedBytes -= bufferBytes;
    buffer = undefined;
    bufferBytes = 0;
    events = 0;
    deadline = 0;
    return value;
  }
  try {
    signal.throwIfAborted();
    iterator = factory(signal)[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      if (buffer && Date.now() >= deadline) {
        yield drain();
        continue;
      }
      pending ??= Promise.resolve()
        .then(() => iterator!.next())
        .then(
          (value) => ({ kind: "next", value }) as Next,
          (error) => ({ kind: "error", error }) as Next,
        );
      let next: Next | { kind: "deadline" };
      if (buffer) {
        try {
          next = await Promise.race([
            pending,
            new Promise<{ kind: "deadline" }>((resolve) => {
              timer = setTimeout(
                () => resolve({ kind: "deadline" }),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          timer = undefined;
        }
      } else next = await pending;
      if (next.kind === "deadline") {
        yield drain();
        continue;
      }
      pending = undefined;
      if (next.kind === "error") {
        if (buffer) yield drain();
        throw next.error;
      }
      if (next.value.done) {
        completed = true;
        if (buffer) yield drain();
        return;
      }
      const event = next.value.value;
      if (event.type !== "text_delta" && event.type !== "thought_delta") {
        if (buffer) yield drain();
        yield event;
        continue;
      }
      if (typeof event.delta !== "string" || event.delta.length > INPUT_BYTES)
        throw new AgentRuntimeError(
          "Native stream delta exceeds its input size limit.",
          "STREAM_DELTA_TOO_LARGE",
          413,
        );
      const incomingBytes = Buffer.byteLength(event.delta);
      if (incomingBytes > INPUT_BYTES)
        throw new AgentRuntimeError(
          "Native stream delta exceeds its input size limit.",
          "STREAM_DELTA_TOO_LARGE",
          413,
        );
      if (!event.delta.length) continue;
      reserve(incomingBytes);
      try {
        if (buffer && buffer.type !== event.type) yield drain();
        let offset = 0;
        while (offset < event.delta.length) {
          signal.throwIfAborted();
          const end = deltaEnd(event.delta, offset, BURST_BYTES - bufferBytes);
          if (end === offset) {
            yield drain();
            continue;
          }
          const piece = event.delta.slice(offset, end),
            bytes = Buffer.byteLength(piece);
          reserve(bytes);
          if (!buffer) {
            buffer = { type: event.type, delta: piece };
            deadline = Date.now() + BURST_MS;
          } else buffer.delta += piece;
          bufferBytes += bytes;
          offset = end;
          if (bufferBytes === BURST_BYTES) yield drain();
        }
        if (buffer && ++events >= BURST_EVENTS) yield drain();
      } finally {
        reservedBytes -= incomingBytes;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (buffer) drain();
    cancellation.abort(new Error("Model delta consumer closed."));
    // pending has an attached rejection handler. Abort before requesting return,
    // otherwise an async generator can queue return behind a stalled next().
    if (!completed && iterator?.return) await iterator.return();
  }
}
