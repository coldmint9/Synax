import { fileBackedReplayEnabled } from "./replay-storage.js";

/**
 * These events are useful while a run is live, but they are already carried by
 * the replay stream and do not participate in recovery, task reconstruction or
 * authorization. Keeping them out of agent_runtime_events removes one SQLite
 * insert per streamed delta in the production storage-owner path.
 */
const REPLAY_ONLY_EVENT_TYPES = new Set([
  "message_delta",
  "thought_delta",
  "progress_updated",
]);

export function shouldPersistRuntimeEvent(
  type: string,
  options: { versioned: boolean; boundaryOnly: boolean },
): boolean {
  if (!fileBackedReplayEnabled()) return true;
  if (options.versioned || options.boundaryOnly) return true;
  return !REPLAY_ONLY_EVENT_TYPES.has(type);
}
