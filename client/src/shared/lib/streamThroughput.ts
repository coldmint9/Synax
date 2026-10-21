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
  samples: Array<{ at: number; total: number }>;
}

export const TOKEN_RATE_WINDOW_MS = 2_000;
export const TOKEN_RATE_IDLE_MS = 1_500;
const MIN_RATE_INTERVAL_MS = 250;

const counters = new Map<string, StreamCounter>();

function counterFor(sessionId: string): StreamCounter {
  let counter = counters.get(sessionId);
  if (!counter) {
    counter = { steps: new Map(), observed: 0, samples: [] };
    counters.set(sessionId, counter);
    if (counters.size > 128) counters.delete(counters.keys().next().value!);
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
    if (counter.steps.size > 256) counter.steps.delete(counter.steps.keys().next().value!);
    if (observed) {
      counter.observed += tokens - previous;
      const now = performance.now();
      const last = counter.samples[counter.samples.length - 1];
      // A new generation interval starts after a tool/network pause. The first
      // packet establishes a baseline; its unknown generation time cannot be
      // inferred from a renderer timer or a historical cumulative token count.
      if (last && (now - last.at >= TOKEN_RATE_IDLE_MS || now < last.at)) counter.samples = [];
      const current = counter.samples[counter.samples.length - 1];
      if (current?.at === now) current.total = counter.observed;
      else counter.samples.push({ at: now, total: counter.observed });
      while (counter.samples.length > 2 && counter.samples[1].at < now - TOKEN_RATE_WINDOW_MS)
        counter.samples.shift();
      if (counter.samples.length > 512) counter.samples.splice(1, counter.samples.length - 512);
    }
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
    retry?: { phase?: unknown };
    liveChunks?: unknown;
    patch?: { status?: unknown };
  },
): void {
  if (!sessionId) return;
  if (event.type === "step_started" ||
      (event.type === "runtime_state" && event.patch?.status && !["running", "queued"].includes(String(event.patch.status)))) {
    const counter = counters.get(sessionId);
    if (counter) counter.samples = [];
    return;
  }
  if (event.type === "message_delta") {
    noteStepTelemetry(sessionId, event.stepId, event.outputTokens, "output", true);
    return;
  }
  if (event.type === "thought_delta") {
    noteStepTelemetry(sessionId, event.stepId, event.thinkingTokens, "thinking", true);
    return;
  }
  if (event.type === "retry_status" &&
      (event.retry?.phase === "waiting" || event.retry?.phase === "group_wait")) {
    // A restarted request reuses the step identity but starts its counters at
    // zero. Keep already observed output while accepting the new attempt.
    const counter = counters.get(sessionId);
    if (counter) counter.samples = [];
    if (typeof event.stepId === "string") {
      counter?.steps.delete(`output:${event.stepId}`);
      counter?.steps.delete(`thinking:${event.stepId}`);
    }
    return;
  }
  if (event.type !== "runtime_snapshot" || !Array.isArray(event.liveChunks)) return;
  // The snapshot is the current attempt's baseline, including a retry that
  // happened while disconnected. Historical output never adds to live speed.
  const counter = counterFor(sessionId);
  counter.steps.clear();
  counter.samples = [];
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

/** Rate of arriving output + reasoning, independent of text reveal/React paints. */
export function readStreamedTokenRate(sessionId: string): number | null {
  const samples = counters.get(sessionId)?.samples;
  if (!samples || samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  if (performance.now() - latest.at >= TOKEN_RATE_IDLE_MS) return null;
  const cutoff = latest.at - TOKEN_RATE_WINDOW_MS;
  let index = 0;
  while (index + 1 < samples.length && samples[index + 1].at <= cutoff) index++;
  let first = samples[index];
  // Interpolate the leading edge so a sparse, older burst does not inflate
  // the denominator beyond the advertised rolling window.
  if (first.at < cutoff) {
    const next = samples[index + 1];
    first = { at: cutoff, total: first.total + (next.total - first.total) * (cutoff - first.at) / (next.at - first.at) };
  }
  const elapsed = latest.at - first.at;
  return elapsed >= MIN_RATE_INTERVAL_MS ? (latest.total - first.total) * 1000 / elapsed : null;
}

/** Test helper — the counters are module state, not store state. */
export function resetStreamedTokensForTests(): void {
  counters.clear();
}
