import { getGlobalConfig } from "../../lib/config/config-store.js";
import { logger } from "../../lib/logger.js";
import { agentRuntimeStore } from "./session-store.js";

const DAY_MS = 86_400_000;
let running: Promise<number> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

export function runSessionArchiveRetention(now = Date.now()): Promise<number> {
  if (running) return running;
  running = Promise.resolve().then(() => {
    const configuredDays = getGlobalConfig().sessionArchiveRetentionDays;
    const days = configuredDays === undefined ? 7 : configuredDays;
    if (days === null) return 0;
    const cutoff = new Date(now - days * DAY_MS).toISOString();
    let deleted = 0;
    for (const batchId of agentRuntimeStore.listExpiredArchiveBatchIds(cutoff)) {
      try {
        deleted += agentRuntimeStore.deleteArchivedBatch(batchId).length;
      } catch (error) {
        logger.warn({ batchId, error }, "archive retention cleanup failed");
      }
    }
    return deleted;
  }).finally(() => {
    running = null;
  });
  return running;
}

export function startSessionArchiveRetention(): () => void {
  void runSessionArchiveRetention();
  timer ??= setInterval(() => void runSessionArchiveRetention(), DAY_MS);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
