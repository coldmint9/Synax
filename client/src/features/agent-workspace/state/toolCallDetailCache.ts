import type { ToolCallRecord } from "../../../adapters/transport/agentRuntime";

/**
 * The bounded summary a transcript row carries for one tool call. A history
 * page ships previews only; `TOOL_CALL_PREVIEW_MARKER` records that fact.
 */
export interface ToolCallDescriptor {
  id: string;
  toolId: string;
  inputSummary?: string;
  outputSummary?: string;
  status?: string;
  category?: string;
  mutability?: string;
  error?: string | null;
}

/**
 * The persisted tool-call record the transcript needs once a reader opens one
 * call. `null` means "the runtime kept no record"; a failed load is never
 * cached, so a retry can actually retry.
 */
export type StoredToolCallRecord = ToolCallRecord | null;

/**
 * Transport hook injected once by the session store, so this module can fetch
 * one durable record without importing the HTTP adapter.
 */
export type ToolCallRecordLoader = (
  sessionId: string,
  toolCallId: string,
) => Promise<StoredToolCallRecord>;

/**
 * History rows carry at most this much of each summary, which keeps the initial
 * response small; the full input/output is fetched only when a row expands.
 */
const TOOL_CALL_PREVIEW_CHARS = 240;

/** Marks a descriptor whose summaries are already clipped by the history row. */
export const TOOL_CALL_PREVIEW_MARKER = Symbol("synax.tool-call-preview");

export type PreviewToolCallDescriptor = ToolCallDescriptor & {
  [TOOL_CALL_PREVIEW_MARKER]?: true;
};

/** Keyed by toolCallId, which is stable and unique per runtime record. */
const detailCache = new Map<string, StoredToolCallRecord>();
/** Bumped on every publish, so subscribers re-read a confirmed miss too. */
let cacheVersion = 0;
/** Rows awaiting an answer for one call, so a confirmed miss still repaints. */
const waiters = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();
const inflight = new Map<string, Promise<StoredToolCallRecord>>();
const settledListeners = new Set<() => void>();
let loadRecord: ToolCallRecordLoader | null = null;

/**
 * Full-record cap. A long transcript touches many calls; keep the recently
 * opened ones and drop the coldest detail first.
 */
const DETAIL_CACHE_LIMIT = 256;

function publish(): void {
  cacheVersion += 1;
  for (const listener of settledListeners) listener();
  for (const [id, waiter] of waiters) {
    if (!detailCache.has(id)) continue;
    waiters.delete(id);
    waiter.resolve();
  }
}

/** Snapshot of the publish counter; pair it with the lookup it guards. */
export function toolCallDetailVersion(): number {
  return cacheVersion;
}

export function subscribeToolCallDetails(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

/** Wired once at startup; transport ownership stays in the session store. */
export function setToolCallRecordLoader(loader: ToolCallRecordLoader): void {
  loadRecord = loader;
}

function isPreviewOnly(record: PreviewToolCallDescriptor | undefined): boolean {
  return Boolean(record?.[TOOL_CALL_PREVIEW_MARKER]);
}

function previewText(value: string | null | undefined): string {
  return (value ?? "").slice(0, TOOL_CALL_PREVIEW_CHARS);
}

function looksClipped(value: string | null | undefined): boolean {
  return (value ?? "").length >= TOOL_CALL_PREVIEW_CHARS;
}

/** True when the descriptor itself proves that its summaries are incomplete. */
function descriptorNeedsDetail(record: ToolCallDescriptor): boolean {
  return (
    isPreviewOnly(record) ||
    looksClipped(record.inputSummary) ||
    looksClipped(record.outputSummary) ||
    looksClipped(record.error)
  );
}

/**
 * Resolve once the runtime has answered for this call (a record or a confirmed
 * miss). Rows use it to leave their pending state without polling.
 */
export function toolCallDetailsSettled(id: string): Promise<void> {
  if (detailCache.has(id)) return Promise.resolve();
  const waiting = waiters.get(id);
  if (waiting) return waiting.promise;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  waiters.set(id, { promise, resolve });
  return promise;
}

/**
 * Drop one cached record after the runtime rewrote it (rollback, fork, or an
 * edited turn), so the next expand re-reads the saved truth.
 */
export function invalidateToolCallDetails(toolCallId: string): void {
  const had = detailCache.delete(toolCallId) || inflight.delete(toolCallId);
  if (had) publish();
}

/**
 * Cache resolved payloads. A `null` answer means the runtime kept no record;
 * it is still cached so reopening does not refetch a known miss.
 */
export function rememberToolCallDetails(
  toolCallId: string,
  record: StoredToolCallRecord,
): void {
  detailCache.delete(toolCallId);
  detailCache.set(toolCallId, record);
  if (record && detailCache.size > DETAIL_CACHE_LIMIT) {
    // Opening a call re-inserts it at the end, so the head is the coldest.
    const oldest = detailCache.keys().next().value;
    if (oldest !== undefined && oldest !== toolCallId) detailCache.delete(oldest);
  }
  publish();
}

export function peekToolCallDetails(
  toolCallId: string,
): StoredToolCallRecord | undefined {
  return detailCache.get(toolCallId);
}

export function hasToolCallDetails(toolCallId: string): boolean {
  return detailCache.has(toolCallId);
}

/**
 * Resolve the authoritative record for one tool call. Concurrent callers share
 * a single request; a rejected request clears the in-flight slot so the retry
 * button issued by the drawer can actually retry.
 */
export function loadToolCallDetails(
  sessionId: string,
  toolCallId: string,
): Promise<StoredToolCallRecord> {
  if (detailCache.has(toolCallId))
    return Promise.resolve(detailCache.get(toolCallId) ?? null);
  const running = inflight.get(toolCallId);
  if (running) return running;
  if (!loadRecord)
    return Promise.reject(new Error("Tool call detail loader is not ready."));
  // Answer and publish in the same microtask, so a caller's re-read never sees
  // an in-flight request with no cached value.
  const request = Promise.resolve()
    .then(() => loadRecord!(sessionId, toolCallId))
    .then(
      (record) => {
        inflight.delete(toolCallId);
        rememberToolCallDetails(toolCallId, record);
        return record;
      },
      (error: unknown) => {
        inflight.delete(toolCallId);
        throw error;
      },
    );
  inflight.set(toolCallId, request);
  return request;
}

/** Drop every cached detail, e.g. when the workspace changes projects. */
export function clearToolCallDetailCache(): void {
  if (detailCache.size === 0 && inflight.size === 0) return;
  detailCache.clear();
  inflight.clear();
  publish();
}

/** Build the bounded descriptor a history page may carry for one call. */
export function toolCallDescriptor(call: {
  id: string;
  toolId: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  status?: string;
  category?: string;
  mutability?: string;
  error?: string | null;
}): PreviewToolCallDescriptor {
  return {
    id: call.id,
    toolId: call.toolId,
    inputSummary: previewText(call.inputSummary),
    outputSummary: previewText(call.outputSummary ?? call.error),
    status: call.status,
    category: call.category,
    mutability: call.mutability,
    error: call.error,
    [TOOL_CALL_PREVIEW_MARKER]: true,
  };
}

/** Pick the newest truth for one call: a cached record wins over its summary. */
export function resolveToolCallRecord<T extends ToolCallDescriptor>(
  call: T,
): T | ToolCallRecord {
  const cached = detailCache.get(call.id);
  return cached ?? call;
}

/** Whether opening this row must fetch something the transcript does not hold. */
export function needsToolCallDetails(call: ToolCallDescriptor): boolean {
  if (detailCache.has(call.id)) return false;
  return descriptorNeedsDetail(call);
}
