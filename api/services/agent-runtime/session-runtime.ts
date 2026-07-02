import type { AgentSession, CreateSessionRequest } from './contracts.js';
import {
  rebuildSessionPermissionRules,
  seedSessionPermissionMetadata,
} from './session-permissions.js';
import { agentContextBuilder } from './context-builder.js';
import { agentEventService, type AgentEventService } from './event-service.js';
import { agentLoopRuntime } from './loop-runtime.js';
import { acpSessionEngine } from './acp-engine/index.js';
import { sessionUsesAcpEngine } from './acp-engine/acp-engine-routing.js';
import { sessionProcessManager } from './session-process-manager.js';
import { profileService, type ProfileService } from './profile-service.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { AgentValidationError } from './runtime-errors.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { sessionHooks } from './session-hooks.js';
import { resolveInitialSessionTitle } from './session-title-service.js';
import { logger } from '../../lib/logger.js';

export class AgentSessionRuntime {
  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly profiles: ProfileService = profileService,
    private readonly events: AgentEventService = agentEventService,
  ) {}

  create(input: CreateSessionRequest): AgentSession {
    const started = Date.now();
    logger.info(
      {
        projectId: input.projectId,
        profileId: input.profileId,
        parentSessionId: input.parentSessionId ?? null,
        nodeId: input.nodeId ?? null,
      },
      '[agent-session] creating session…',
    );

    const parent = input.parentSessionId ? this.store.getSession(input.parentSessionId) : undefined;
    const profile = this.profiles.assertCanStart(input.profileId, { parentSessionId: input.parentSessionId });
    if (parent && parent.projectId !== input.projectId) {
      throw new AgentValidationError('Sub-session projectId must match parent session projectId.');
    }
    const createdAt = nowIso();
    const sessionMetadata = seedSessionPermissionMetadata(input.sessionMetadata ?? null, {
      permissionTier: input.permissionTier,
      permissionOverrides: input.permissionOverrides,
    });
    const sessionDraft: AgentSession = {
      id: makeRuntimeId('ars'),
      projectId: input.projectId,
      parentSessionId: input.parentSessionId ?? null,
      childSessionIds: [],
      nodeId: input.nodeId ?? null,
      profileId: profile.id,
      status: 'running',
      title: resolveInitialSessionTitle({
        sessionMetadata,
        prompt: input.prompt,
      }),
      prompt: input.prompt,
      contextSnapshotId: null,
      thinkingMode: input.thinkingMode ?? profile.defaultThinkingMode,
      permissionRules: [],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      resultSummary: null,
      blockedReason: null,
      skillIds: input.skillIds ?? [],
      activeRunId: null,
      pendingResumeToken: null,
      sessionMetadata,
    };
    const session: AgentSession = {
      ...sessionDraft,
      permissionRules: rebuildSessionPermissionRules(sessionDraft, profile.permissionDefaults),
    };
    const saved = this.store.createSession(session);
    const bundle = agentContextBuilder.build(input.projectId, {
      nodeId: input.nodeId ?? undefined,
      profileId: profile.id,
      sessionId: saved.id,
    });
    this.store.updateSession(saved.id, { contextSnapshotId: bundle.id, updatedAt: nowIso() });
    this.events.append({
      sessionId: saved.id,
      type: 'session_started',
      summary: `${profile.label} session started`,
      payload: { profileId: profile.id, parentSessionId: saved.parentSessionId, contextSnapshotId: bundle.id },
    });
    if (parent) {
      this.events.append({
        sessionId: parent.id,
        type: 'subsession_started',
        summary: `Started ${profile.label} sub-session`,
        payload: { childSessionId: saved.id, profileId: profile.id, inheritedPermission: true },
      });
    }
    const created = this.store.getSession(saved.id);
    void sessionHooks.emit({ type: 'session:created', session: created });
    logger.info(
      {
        sessionId: created.id,
        projectId: created.projectId,
        profileId: created.profileId,
        parentSessionId: created.parentSessionId,
        title: created.title,
        durationMs: Date.now() - started,
      },
      '[agent-session] session created',
    );
    return created;
  }

  get(sessionId: string): AgentSession {
    return this.store.getSession(sessionId);
  }

  list(filter: { projectId?: string; nodeId?: string; status?: string; limit?: number }): AgentSession[] {
    return this.store.listSessions(filter);
  }

  listSessionTree(sessionId: string): AgentSession[] {
    return this.store.listSessionTree(sessionId);
  }

  cancel(sessionId: string): AgentSession {
    const current = this.store.getSession(sessionId);
    const now = nowIso();
    const reason = 'User stopped run.';

    agentLoopRuntime.interruptSessions([sessionId], reason);
    sessionProcessManager.interruptSessions([sessionId], reason);

    if (current.activeRunId) {
      const run = this.store.getRun(current.activeRunId);
      this.store.updateRun(run.id, {
        status: 'interrupted',
        completedAt: now,
        stopReason: reason,
      });
      for (const step of this.store.listRunSteps(run.id)) {
        if (!step.completedAt) {
          this.store.updateRunStep(step.id, {
            status: 'cancelled',
            completedAt: now,
            finishReason: 'cancelled',
          });
        }
      }
    }
    const session = this.store.updateSession(sessionId, {
      status: 'interrupted',
      updatedAt: now,
      completedAt: null,
      resultSummary: reason,
      blockedReason: null,
      activeRunId: null,
      pendingResumeToken: null,
    });
    this.events.append({
      sessionId,
      type: 'progress_updated',
      summary: 'Session stopped',
      payload: { reason, preservedEvents: true, resumable: true },
    });
    return session;
  }

  pause(sessionId: string): AgentSession {
    const current = this.store.getSession(sessionId);
    if (current.status !== 'running' && current.status !== 'waiting_permission') {
      throw new AgentValidationError('Only running or waiting_permission sessions can be paused.');
    }
    const session = this.store.updateSession(sessionId, {
      status: 'paused',
      updatedAt: nowIso(),
      blockedReason: 'User paused session.',
    });
    agentLoopRuntime.interruptSessions([sessionId], 'User paused session.');
    if (sessionUsesAcpEngine(sessionId)) {
      void acpSessionEngine.interruptSession(sessionId, 'User paused session.');
    }
    this.events.append({
      sessionId,
      type: 'progress_updated',
      summary: 'Session paused',
      payload: { reason: 'User paused session.', resumable: true },
    });
    return session;
  }

  delete(sessionId: string): string[] {
    void sessionHooks.emit({ type: 'session:deleted', sessionId });
    return this.store.deleteSessionTree(sessionId);
  }
}

export const agentSessionRuntime = new AgentSessionRuntime();
