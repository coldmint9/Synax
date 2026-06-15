import { notify } from '../../services/notifications/notify.js';
import { taskNotificationBus, TaskNotificationEventType } from '../../services/notifications/task-notification-bus.js';
import { runtimeBus } from '../../services/agent-runtime/runtime-bus.js';
import { sessionLiveBus } from '../../services/agent-runtime/session-live-bus.js';
import { logger } from '../logger.js';
import type { WikiJobChildMessage } from './protocol.js';

const SCAN_NOTIFY_MIN_INTERVAL_MS = 2_000;
const SCAN_NOTIFY_MIN_PCT_STEP = 10;

let lastScanNotifyAt = 0;
let lastScanNotifyPct = -1;

function shouldEmitScanTaskProgress(pct?: number): boolean {
  if (pct === 0 || pct === 100) return true;
  const now = Date.now();
  if (pct !== undefined && pct - lastScanNotifyPct >= SCAN_NOTIFY_MIN_PCT_STEP) return true;
  if (now - lastScanNotifyAt >= SCAN_NOTIFY_MIN_INTERVAL_MS) return true;
  return false;
}

function recordScanTaskProgress(pct?: number): void {
  lastScanNotifyAt = Date.now();
  if (pct !== undefined) lastScanNotifyPct = pct;
}

export function resetScanProgressThrottleForTests(): void {
  lastScanNotifyAt = 0;
  lastScanNotifyPct = -1;
}

export function handleWikiJobChildMessage(message: WikiJobChildMessage): void {
  switch (message.type) {
    case 'ipc:notify':
      notify(message.opts);
      break;
    case 'ipc:event':
      taskNotificationBus.emit(message.event);
      break;
    case 'runtime:event':
      runtimeBus.emit(message.event);
      break;
    case 'session:live':
      sessionLiveBus.emit(message.sessionId, message.event);
      break;
    case 'scan:progress': {
      logger.info(`[analyzer] ${message.message}`, {
        pct: message.pct,
        completed: message.completed,
        total: message.total,
        projectId: message.projectId,
      });
      if (message.projectId && shouldEmitScanTaskProgress(message.pct)) {
        recordScanTaskProgress(message.pct);
        notify({
          type: TaskNotificationEventType.TaskProgress,
          taskKind: 'wiki_generate',
          projectId: message.projectId,
          taskId: message.projectId,
          title: 'Wiki',
          message: message.message,
          severity: 'info',
          meta: {
            phase: 'scan',
            activity: message.message,
            pct: message.pct,
            completed: message.completed,
            total: message.total,
          },
        });
      }
      break;
    }
    case 'job:done':
      logger.info({ projectId: message.projectId }, '[wiki-job] child completed');
      break;
    case 'job:error':
      logger.error({ projectId: message.projectId, error: message.error }, '[wiki-job] child failed');
      break;
    default:
      break;
  }
}
