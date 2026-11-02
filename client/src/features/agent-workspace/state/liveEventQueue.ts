import type { SessionLiveEvent } from "../../../adapters/transport/sessionLive";

/** One live record together with the stream that delivered it. */
export interface LiveEventInput {
  event: SessionLiveEvent;
  /**
   * The session whose live stream produced this record. Deltas, steps, tool
   * records and retries carry no session id of their own, so a stale stream can
   * only be told apart from the selected one here.
   */
  streamSessionId?: string;
}

/**
 * One run answers with a burst: a step starts, its tool calls and results land,
 * a message is persisted, a status event follows — all describing one moment.
 * Committing each record as it arrives re-renders the whole conversation per
 * record, so the stream is collected and handed to the store once per frame.
 */
export const LIVE_EVENT_BATCH_MS = 16;
/** A burst this large is drained at once instead of waiting for the next frame. */
const MAX_QUEUED_EVENTS = 300;

let queue: LiveEventInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dispatch: ((items: LiveEventInput[]) => void) | null = null;

/** The store owns the commit; the queue only decides when a frame is complete. */
export function setLiveEventDispatcher(
  next: ((items: LiveEventInput[]) => void) | null,
): void {
  dispatch = next;
}

export function enqueueLiveEvent(
  event: SessionLiveEvent,
  streamSessionId?: string,
): void {
  // A transcript and a bounded viewer can observe the same record; the same
  // object twice in a row is one record, not two.
  if (queue.length > 0 && queue[queue.length - 1].event === event) return;
  queue.push({ event, streamSessionId });
  if (queue.length >= MAX_QUEUED_EVENTS) {
    flushLiveEvents();
    return;
  }
  // Timers also run while an Electron window is hidden, and a single pending
  // timer keeps an idle session free of work.
  if (timer === null) timer = setTimeout(flushLiveEvents, LIVE_EVENT_BATCH_MS);
}

/** Commit every collected record in one call, in the order it arrived. */
export function flushLiveEvents(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (queue.length === 0) return;
  const items = queue;
  queue = [];
  try {
    dispatch?.(items);
  } catch (error) {
    // The transport wraps each handler this way; a batch that fails must not
    // surface as an unhandled timer error and take the rest of the frame down.
    console.error("Live event batch failed", error);
  }
}

/** Drop collected records without committing them. */
export function discardQueuedLiveEvents(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
}

/** Test seam: the queue is otherwise invisible to callers. */
export function queuedLiveEventCount(): number {
  return queue.length;
}
