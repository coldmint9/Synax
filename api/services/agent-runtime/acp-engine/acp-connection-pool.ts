import { withDeadline } from '../managed-process.js';
import type { AgentCapabilities, SessionModelState } from '@agentclientprotocol/sdk';
import {
  cancelAcpPrompt,
  closeAcpSession,
  initializeProtocol,
  openAcpSession,
  resolveSpawnForProvider,
  resolveSpawnForProviderAsync,
  setAcpSessionModel,
  spawnAcpConnection,
  type AcpConnection,
} from '../../acp/protocol/acp-connection.js';
import { createWorkspaceClientHandler } from '../../acp/protocol/reverse-handlers.js';
import { ACP_SESSION_IDLE_TIMEOUT_MS, MAX_ACP_SESSIONS } from '../../../lib/env.js';
import { logger } from '../../../lib/logger.js';
import { AgentRuntimeError } from '../runtime-errors.js';
import { agentRuntimeStore } from '../session-store.js';
import { resolveSessionWorkDir } from '../tools/workspace.js';
import type { AcpProviderId } from './acp-model.js';
import { getAcpSessionMetadata, mergeAcpSessionMetadata } from './acp-session-metadata.js';
import { acpSessionUpdateRouter } from './acp-session-update-router.js';
import { acpPermissionBridge } from './acp-permission-bridge.js';

export interface PooledAcpConnection {
  synaxSessionId: string;
  projectId: string;
  providerId: AcpProviderId;
  acpSessionId: string;
  capabilities: AgentCapabilities;
  connection: AcpConnection;
  workDir: string;
  lastUsedAt: number;
  isReplay: boolean;
  sessionModels?: SessionModelState | null;
  currentModelId?: string | null;
}

type AcquireInput = {
  synaxSessionId: string;
  projectId: string;
  providerId: AcpProviderId;
};

class AcpConnectionPool {
  private readonly pool = new Map<string, PooledAcpConnection>();
  private readonly acquisitions = new Map<string, { task: Promise<PooledAcpConnection>; controller: AbortController }>();
  private readonly evictions = new Map<string, Promise<void>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.idleTimer = setInterval(() => this.evictIdleConnections(), 60_000);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  count(): number {
    return this.pool.size;
  }

  canAcquire(synaxSessionId?: string): boolean {
    if (synaxSessionId && (this.pool.has(synaxSessionId) || this.acquisitions.has(synaxSessionId))) return true;
    return new Set([...this.pool.keys(), ...this.acquisitions.keys()]).size < MAX_ACP_SESSIONS;
  }

  assertCanAcquire(synaxSessionId?: string): void {
    if (this.canAcquire(synaxSessionId)) return;
    throw new AgentRuntimeError(
      `Too many active ACP sessions (max ${MAX_ACP_SESSIONS}).`,
      'SESSION_LIMIT',
      429,
    );
  }

  get(synaxSessionId: string): PooledAcpConnection | undefined {
    return this.pool.get(synaxSessionId);
  }

  async acquire(input: AcquireInput): Promise<PooledAcpConnection> {
    const pending = this.acquisitions.get(input.synaxSessionId);
    if (pending) return pending.task;
    this.assertCanAcquire(input.synaxSessionId);
    const controller = new AbortController();
    const task = Promise.resolve().then(() => this.openConnection(input, controller.signal));
    this.acquisitions.set(input.synaxSessionId, { task, controller });
    try { return await task; } finally { this.acquisitions.delete(input.synaxSessionId); }
  }

  private async openConnection(input: AcquireInput, signal: AbortSignal): Promise<PooledAcpConnection> {
    if (signal.aborted) throw new Error('ACP connection cancelled before launch.');
    await this.evictions.get(input.synaxSessionId);
    if (signal.aborted) throw new Error('ACP connection cancelled before launch.');
    this.assertCanAcquire(input.synaxSessionId);
    const existing = this.pool.get(input.synaxSessionId);
    if (existing && existing.connection.child.exitCode === null
      && existing.connection.child.signalCode === null && !existing.connection.child.killed) {
      if (existing.providerId !== input.providerId) throw new AgentRuntimeError('Cannot change the backend of an existing connection.', 'BACKEND_MISMATCH', 409);
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) {
      await this.evict(input.synaxSessionId, false);
    }
    if (signal.aborted) throw new Error('ACP connection cancelled before launch.');

    const session = agentRuntimeStore.getSession(input.synaxSessionId);
    const workDir = resolveSessionWorkDir(input.synaxSessionId, input.projectId);
    const stored = getAcpSessionMetadata(session);
    const spawnSpec = input.providerId === 'cursor-acp'
      ? await resolveSpawnForProviderAsync(input.providerId)
      : resolveSpawnForProvider(input.providerId);
    const synaxSessionId = input.synaxSessionId;
    const connection = spawnAcpConnection(createWorkspaceClientHandler(workDir, {
      async sessionUpdate(params) {
        acpSessionUpdateRouter.dispatch(synaxSessionId, params);
      },
      async requestPermission(params) {
        return acpPermissionBridge.handleRequest(params, synaxSessionId);
      },
    }), spawnSpec, workDir);
    const cancelOpening = () => {
      if (connection.stop) void connection.stop().catch(error => logger.warn({ synaxSessionId, error }, '[AcpConnectionPool] opening shutdown unconfirmed'));
      else connection.cleanup();
    };
    signal.addEventListener('abort', cancelOpening, { once: true });
    try {
      if (signal.aborted) { cancelOpening(); throw new Error('ACP connection cancelled.'); }
      const { capabilities } = await withDeadline(initializeProtocol(connection.conn), 30_000, 'ACP handshake timed out.');

      let isReplay = false;
      let acpSessionId: string;
      let sessionModels: SessionModelState | null | undefined;
      let currentModelId: string | null | undefined;
      if (stored?.acpSessionId) {
        // loadSession replays before it resolves; subsequent prompts are live.
        isReplay = false;
        const opened = await openAcpSession(connection.conn, {
          cwd: workDir,
          acpSessionId: stored.acpSessionId,
          capabilities,
        });
        acpSessionId = opened.sessionId;
        sessionModels = opened.models;
        currentModelId = opened.models?.currentModelId ?? null;
      } else {
        const opened = await openAcpSession(connection.conn, {
          cwd: workDir,
          capabilities,
        });
        acpSessionId = opened.sessionId;
        sessionModels = opened.models;
        currentModelId = opened.models?.currentModelId ?? null;
      }

      agentRuntimeStore.updateSession(input.synaxSessionId, {
        sessionMetadata: mergeAcpSessionMetadata(session, {
          providerId: input.providerId,
          acpSessionId,
          capabilities,
        }),
        updatedAt: new Date().toISOString(),
      });

      const pooled: PooledAcpConnection = {
        synaxSessionId: input.synaxSessionId,
        projectId: input.projectId,
        providerId: input.providerId,
        acpSessionId,
        capabilities,
        connection,
        workDir,
        lastUsedAt: Date.now(),
        isReplay,
        sessionModels,
        currentModelId,
      };
      this.pool.set(input.synaxSessionId, pooled);
      logger.info(
        {
          synaxSessionId: input.synaxSessionId,
          acpSessionId,
          providerId: input.providerId,
          isReplay,
        },
        '[AcpConnectionPool] acquired connection',
      );
      return pooled;
    } catch (error) {
      if (connection.stop) await connection.stop(); else connection.cleanup();
      throw error;
    } finally { signal.removeEventListener('abort', cancelOpening); }
  }

  touch(synaxSessionId: string): void {
    const entry = this.pool.get(synaxSessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  async applySessionModel(synaxSessionId: string, modelId: string): Promise<void> {
    const entry = this.pool.get(synaxSessionId);
    if (!entry || !modelId.trim()) return;
    if (entry.currentModelId === modelId) return;
    try {
      const applied = await setAcpSessionModel(entry.connection.conn, entry.acpSessionId, modelId);
      if (applied) {
        entry.currentModelId = modelId;
        if (entry.sessionModels) {
          entry.sessionModels = { ...entry.sessionModels, currentModelId: modelId };
        }
      }
    } catch (error) {
      logger.warn({ synaxSessionId, modelId, error }, '[AcpConnectionPool] setSessionModel failed');
    }
  }

  clearReplay(synaxSessionId: string): void {
    const entry = this.pool.get(synaxSessionId);
    if (entry) entry.isReplay = false;
  }

  async cancelPrompt(synaxSessionId: string): Promise<void> {
    const entry = this.pool.get(synaxSessionId);
    if (!entry) return;
    try {
      await cancelAcpPrompt(entry.connection.conn, entry.acpSessionId);
    } catch (error) {
      logger.warn({ synaxSessionId, error }, '[AcpConnectionPool] cancel failed');
    }
  }

  async evict(synaxSessionId: string, cancelOpening = true): Promise<void> {
    // Replacing a dead cached host must not await/cancel its own acquisition.
    const acquisition = cancelOpening ? this.acquisitions.get(synaxSessionId) : undefined;
    acquisition?.controller.abort();
    const pending = this.evictions.get(synaxSessionId);
    if (pending) {
      await pending;
      if (acquisition) await withDeadline(acquisition.task.catch(() => undefined), 5000, 'ACP opening shutdown unconfirmed.');
      return;
    }
    const task = (async () => {
      if (acquisition) await withDeadline(acquisition.task.catch(() => undefined), 5000, 'ACP opening shutdown unconfirmed.');
      const entry = this.pool.get(synaxSessionId);
      if (!entry) return;
      acpSessionUpdateRouter.clear(synaxSessionId);
      try { await withDeadline(closeAcpSession(entry.connection.conn, entry.acpSessionId), 500, 'ACP close timed out.'); }
      catch { /* Closing the owned process is the authoritative shutdown below. */ }
      if (entry.connection.stop) await entry.connection.stop(); else entry.connection.cleanup();
      this.pool.delete(synaxSessionId);
      logger.info({ synaxSessionId }, '[AcpConnectionPool] evicted connection');
    })();
    this.evictions.set(synaxSessionId, task);
    try { await task; } finally { this.evictions.delete(synaxSessionId); }
  }

  private evictIdleConnections(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.pool.entries()) {
      if (now - entry.lastUsedAt >= ACP_SESSION_IDLE_TIMEOUT_MS) {
        let busy = false;
        try { busy = Boolean(agentRuntimeStore.getSession(sessionId).activeRunId); } catch { /* Orphan connection. */ }
        if (!busy) void this.evict(sessionId).catch(error => logger.warn({ sessionId, error }, '[AcpConnectionPool] idle shutdown unconfirmed'));
      }
    }
  }
}

export const acpConnectionPool = new AcpConnectionPool();
