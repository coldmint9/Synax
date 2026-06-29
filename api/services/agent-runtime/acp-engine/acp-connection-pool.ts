import type { AgentCapabilities } from '@agentclientprotocol/sdk';
import {
  cancelAcpPrompt,
  closeAcpSession,
  initializeProtocol,
  openAcpSession,
  resolveSpawnForProvider,
  resolveSpawnForProviderAsync,
  spawnAcpConnection,
  type AcpConnection,
} from '../../acp/protocol/acp-connection.js';
import { createClientHandler } from '../../acp/protocol/reverse-handlers.js';
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
}

type AcquireInput = {
  synaxSessionId: string;
  projectId: string;
  providerId: AcpProviderId;
};

class AcpConnectionPool {
  private readonly pool = new Map<string, PooledAcpConnection>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.idleTimer = setInterval(() => this.evictIdleConnections(), 60_000);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  count(): number {
    return this.pool.size;
  }

  canAcquire(synaxSessionId?: string): boolean {
    if (synaxSessionId && this.pool.has(synaxSessionId)) return true;
    return this.pool.size < MAX_ACP_SESSIONS;
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
    this.assertCanAcquire(input.synaxSessionId);
    const existing = this.pool.get(input.synaxSessionId);
    if (existing?.connection.child.connected) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) {
      await this.evict(input.synaxSessionId);
    }

    const session = agentRuntimeStore.getSession(input.synaxSessionId);
    const workDir = resolveSessionWorkDir(input.synaxSessionId, input.projectId);
    const stored = getAcpSessionMetadata(session);
    const spawnSpec = input.providerId === 'cursor-acp'
      ? await resolveSpawnForProviderAsync(input.providerId)
      : resolveSpawnForProvider(input.providerId);
    const synaxSessionId = input.synaxSessionId;
    const connection = spawnAcpConnection(createClientHandler({
      async sessionUpdate(params) {
        acpSessionUpdateRouter.dispatch(synaxSessionId, params);
      },
      async requestPermission(params) {
        return acpPermissionBridge.handleRequest(params);
      },
    }), spawnSpec);
    const { capabilities } = await initializeProtocol(connection.conn);

    let isReplay = false;
    let acpSessionId: string;
    if (stored?.acpSessionId) {
      isReplay = Boolean(capabilities.loadSession);
      acpSessionId = await openAcpSession(connection.conn, {
        cwd: workDir,
        acpSessionId: stored.acpSessionId,
        capabilities,
      });
    } else {
      acpSessionId = await openAcpSession(connection.conn, {
        cwd: workDir,
        capabilities,
      });
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
  }

  touch(synaxSessionId: string): void {
    const entry = this.pool.get(synaxSessionId);
    if (entry) entry.lastUsedAt = Date.now();
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

  async evict(synaxSessionId: string): Promise<void> {
    const entry = this.pool.get(synaxSessionId);
    if (!entry) return;
    this.pool.delete(synaxSessionId);
    acpSessionUpdateRouter.clear(synaxSessionId);
    try {
      await closeAcpSession(entry.connection.conn, entry.acpSessionId);
    } catch {
      // ignore close errors during eviction
    }
    entry.connection.cleanup();
    logger.info({ synaxSessionId }, '[AcpConnectionPool] evicted connection');
  }

  private evictIdleConnections(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.pool.entries()) {
      if (now - entry.lastUsedAt >= ACP_SESSION_IDLE_TIMEOUT_MS) {
        void this.evict(sessionId);
      }
    }
  }
}

export const acpConnectionPool = new AcpConnectionPool();
