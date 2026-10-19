/**
 * Live output-token counter for the streaming throughput readout.
 *
 * Counted at the single place where a live SSE stream fans out inside the
 * renderer (sessionLiveClient), keyed by session: the transcript
 * store and the dock stream both consume the same deltas, so counting inside
 * either consumer would double count or miss events depending on which is
 * attached. Text and reasoning have separate cumulative counts per step.
 * Snapshots seed the counters without recording historical output as live.
 */

interface StreamCounter {
  steps: Map<string, number>;
  observed: number;
}

const counters = new Map<string, StreamCounter>();

function counterFor(sessionId: string): StreamCounter {
  let counter = counters.get(sessionId);
  if (!counter) {
    counter = { steps: new Map(), observed: 0 };
    counters.set(sessionId, counter);
  }
  return counter;
}

function noteStepTelemetry(
  sessionId: string,
  stepId: unknown,
  tokens: unknown,
  kind: "output" | "thinking",
  observed: boolean,
): void {
  if (typeof stepId !== "string" || !stepId) return;
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) return;
  const counter = counterFor(sessionId);
  const key = `${kind}:${stepId}`;
  const previous = counter.steps.get(key) ?? 0;
  if (tokens > previous) {
    counter.steps.set(key, tokens);
    if (observed) counter.observed += tokens - previous;
  }
}

/** Ingest output telemetry from deltas and reconnect snapshots. */
export function noteLiveEvent(
  sessionId: string,
  event: {
    type: string;
    stepId?: unknown;
    outputTokens?: unknown;
    thinkingTokens?: unknown;
    liveChunks?: unknown;
  },
): void {
  if (!sessionId) return;
  if (event.type === "message_delta") {
    noteStepTelemetry(sessionId, event.stepId, event.outputTokens, "output", true);
    return;
  }
  if (event.type === "thought_delta") {
    noteStepTelemetry(sessionId, event.stepId, event.thinkingTokens, "thinking", true);
    return;
  }
  if (event.type !== "runtime_snapshot" || !Array.isArray(event.liveChunks)) return;
  for (const chunk of event.liveChunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const value = chunk as { type?: unknown; stepId?: unknown; outputTokens?: unknown; thinkingTokens?: unknown };
    if (value.type === "message_delta")
      noteStepTelemetry(sessionId, value.stepId, value.outputTokens, "output", false);
    else if (value.type === "thought_delta")
      noteStepTelemetry(sessionId, value.stepId, value.thinkingTokens, "thinking", false);
  }
}

/** Monotonic output + reasoning tokens observed since the live listener attached. */
export function readStreamedTokens(sessionId: string): number {
  const counter = counters.get(sessionId);
  if (!counter) return 0;
  return counter.observed;
}

/** Test helper — the counters are module state, not store state. */
export function resetStreamedTokensForTests(): void {
  counters.clear();
}
