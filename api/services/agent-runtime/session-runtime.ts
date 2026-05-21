import type { AgentSession, CreateSessionRequest } from './contracts.js';
import { agentContextBuilder } from './context-builder.js';
import { agentEventService, type AgentEventService } from './event-service.js';
import { agentLoopRuntime } from './loop-runtime.js';
import { profileService, type ProfileService } from './profile-service.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { AgentValidationError } from './runtime-errors.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { sessionHooks } from './session-hooks.js';

export class AgentSessionRuntime {
  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly profiles: ProfileService = profileService,
    private readonly events: AgentEventService = agentEventService,
  ) {}

  create(input: CreateSessionRequest): AgentSession {
    const parent = input.parentSessionId ? this.store.getSession(input.parentSessionId) : undefined;
    const profile = this.profiles.assertCanStart(input.profileId, { parentSessionId: input.parentSessionId });
    if (parent && parent.projectId !== input.projectId) {
      throw new AgentValidationError('Sub-session projectId must match parent session projectId.');
    }
    const createdAt = nowIso();
    const inheritedRules = parent?.permissionRules ?? [];
    const session: AgentSession = {
      id: makeRuntimeId('ars'),
      projectId: input.projectId,
      parentSessionId: input.parentSessionId ?? null,
      childSessionIds: [],
      nodeId: input.nodeId ?? null,
      profileId: profile.id,
      status: 'running',
      title: null,
      prompt: input.prompt,
      contextSnapshotId: null,
      thinkingMode: input.thinkingMode ?? profile.defaultThinkingMode,
      permissionRules: [...inheritedRules, ...profile.permissionDefaults],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      resultSummary: null,
      blockedReason: null,
      skillIds: input.skillIds ?? profile.defaultSkills,
      activeRunId: null,
      pendingResumeToken: null,
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
    if (current.activeRunId) {
      const run = this.store.getRun(current.activeRunId);
      this.store.updateRun(run.id, {
        status: 'cancelled',
        completedAt: now,
        stopReason: 'Session cancelled.',
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
      status: 'cancelled',
      updatedAt: now,
      completedAt: now,
      resultSummary: 'Session cancelled.',
      blockedReason: null,
      activeRunId: null,
      pendingResumeToken: null,
    });
    this.events.append({
      sessionId,
      type: 'progress_updated',
      summary: 'Session cancelled',
      payload: { reason: 'User cancelled run.', preservedEvents: true },
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
