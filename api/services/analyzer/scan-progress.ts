import { parentPort } from 'node:worker_threads';
import { logger } from '../../lib/logger.js';

export interface ScanProgressPayload {
  message: string;
  pct?: number;
  completed?: number;
  total?: number;
  projectId?: string;
}

export type ScanProgressListener = (payload: ScanProgressPayload) => void;

let progressListener: ScanProgressListener | null = null;

export function setScanProgressListener(listener: ScanProgressListener | null): void {
  progressListener = listener;
}

/** Report scan progress — forwards to main thread when running in scan pipeline worker. */
export function reportScanProgress(payload: ScanProgressPayload): void {
  if (parentPort) {
    parentPort.postMessage({ type: 'scan:progress', ...payload });
    return;
  }
  deliverScanProgress(payload);
}

/** Handle scan progress on the host thread (API or wiki child main). */
export function deliverScanProgress(payload: ScanProgressPayload): void {
  progressListener?.(payload);
  if (payload.pct !== undefined || payload.completed !== undefined) {
    logger.info(`[analyzer] ${payload.message}`, {
      pct: payload.pct,
      completed: payload.completed,
      total: payload.total,
      projectId: payload.projectId,
    });
    return;
  }
  logger.info(`[analyzer] ${payload.message}`);
}
