import { PERMISSION_TIMEOUT_MS } from '../../infrastructure/runtime/env.js';
import { logger } from '../../infrastructure/runtime/logger.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';

const SWEEP_INTERVAL_MS = 30_000;

let pendingSweep: Promise<number> | undefined;
let generation = 0;

export function sweepExpiredPermissionsAuthoritative(): Promise<number> {
  // A cold replay can outlast the timer. Share that pass instead of queuing
  // another scan of every historical session on each tick.
  return pendingSweep ??= sweepExpiredPermissions().finally(() => { pendingSweep = undefined; });
}

async function sweepExpiredPermissions(): Promise<number> {
  const current = generation;
  const cutoff = Date.now() - PERMISSION_TIMEOUT_MS;
  let swept = 0;
  const sessions = await runtimeFacade.listSessionProjection();
  for (const raw of sessions) {
    if (current !== generation) break;
    if (!raw || typeof raw !== 'object') continue;
    // The Rust list index computes this from authoritative control state.
    // Older sidecars omit it, in which case retain the full-scan fallback.
    if ((raw as { pendingPermissionCount?: unknown }).pendingPermissionCount === 0) continue;
    const sessionId = (raw as { id?: unknown }).id;
    if (typeof sessionId !== 'string') continue;
    let state: { permissions?: unknown[] };
    try {
      state = await runtimeFacade.controlState(sessionId) as { permissions?: unknown[] };
    } catch (error) {
      logger.debug({ sessionId, error }, '[agent-runtime] authoritative permission sweep read failed');
      continue;
    }
    for (const rawPermission of state.permissions ?? []) {
      if (current !== generation) break;
      if (!rawPermission || typeof rawPermission !== 'object') continue;
      const permission = rawPermission as {
        id?: unknown; action?: unknown; resolvedAt?: unknown; createdAt?: unknown;
      };
      if (typeof permission.id !== 'string' || permission.action !== 'ask' || permission.resolvedAt) continue;
      const createdAt = typeof permission.createdAt === 'string' ? Date.parse(permission.createdAt) : NaN;
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
      try {
        await runtimeFacade.controlCommand({
          sessionId,
          requestId: `permission-timeout:${permission.id}`,
          operation: 'permission_reply',
          payload: { id: permission.id, reply: 'reject', message: 'Permission timed out.' },
        });
        swept++;
        logger.warn({ sessionId, permissionId: permission.id }, '[agent-runtime] Rust permission request timed out and was auto-rejected');
      } catch (error) {
        logger.error({ sessionId, permissionId: permission.id, error }, '[agent-runtime] failed to sweep Rust permission');
      }
    }
  }
  return swept;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startPermissionTimeoutSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepExpiredPermissionsAuthoritative().then((count) => {
      if (count > 0) logger.info({ count }, '[agent-runtime] swept expired permission requests');
    }).catch((err) => logger.error({ err }, '[agent-runtime] permission timeout sweep failed'));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopPermissionTimeoutSweeper(): Promise<void> {
  generation++;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  return pendingSweep?.then(() => {}, () => {}) ?? Promise.resolve();
}
