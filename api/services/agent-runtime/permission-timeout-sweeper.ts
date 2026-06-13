import { getRawSqlite } from '../../db/index.js';
import { PERMISSION_TIMEOUT_MS } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { agentEventService } from './event-service.js';
import { permissionPolicy } from './permission-policy.js';
import { agentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';

const SWEEP_INTERVAL_MS = 30_000;

type PermissionRow = {
  id: string;
  session_id: string;
  action: string;
  user_reply: string | null;
  resolved_at: string | null;
  created_at: string;
};

function listExpiredPendingPermissions(cutoffIso: string): PermissionRow[] {
  return getRawSqlite()
    .prepare(
      `SELECT id, session_id, action, user_reply, resolved_at, created_at
       FROM agent_runtime_permissions
       WHERE action = 'ask'
         AND user_reply IS NULL
         AND resolved_at IS NULL
         AND created_at < ?`,
    )
    .all(cutoffIso) as PermissionRow[];
}

export function sweepExpiredPermissions(): number {
  const cutoff = new Date(Date.now() - PERMISSION_TIMEOUT_MS).toISOString();
  const expired = listExpiredPendingPermissions(cutoff);
  let swept = 0;

  for (const row of expired) {
    try {
      const session = agentRuntimeStore.tryGetSession(row.session_id);
      if (!session) continue;

      const decision = permissionPolicy.reply(
        row.session_id,
        row.id,
        'reject',
        'Permission timed out.',
      );

      agentEventService.append({
        sessionId: row.session_id,
        type: 'permission_resolved',
        summary: decision.reason,
        payload: {
          permissionId: decision.id,
          action: decision.action,
          userReply: decision.userReply,
          source: 'permission_timeout',
        },
      });

      agentRuntimeStore.updateSession(row.session_id, {
        status: 'blocked',
        updatedAt: nowIso(),
        blockedReason: 'Permission request timed out.',
        pendingResumeToken: null,
      });

      swept++;
      logger.warn(
        { sessionId: row.session_id, permissionId: row.id },
        '[agent-runtime] permission request timed out and was auto-rejected',
      );
    } catch (err) {
      logger.error(
        { err, sessionId: row.session_id, permissionId: row.id },
        '[agent-runtime] failed to sweep expired permission',
      );
    }
  }

  return swept;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startPermissionTimeoutSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      const count = sweepExpiredPermissions();
      if (count > 0) {
        logger.info({ count }, '[agent-runtime] swept expired permission requests');
      }
    } catch (err) {
      logger.error({ err }, '[agent-runtime] permission timeout sweep failed');
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopPermissionTimeoutSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
