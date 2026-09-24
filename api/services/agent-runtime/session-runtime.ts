import { getRawSqlite } from "../../db/index.js";
import { initializeFreshVersionNative, versionedSession } from "./checkpoints/version-runtime/bridge.js";
import { assertHistoryUnlocked } from "./checkpoints/guards.js";
import { resolveSessionUserRequest } from "./session-user-request.js";
import { normalizeSessionPromptMetadata } from "./session-metadata.js";
import {
  makeBackendBinding,
  validateBackendTurnInput,
} from "./backends/backend-binding.js";
import { resolveWorkspaceRoot } from "./tools/workspace.js";
import type { ProjectWorkspaceRoot } from "../project-workspace.js";
import type { WorkspaceLocation } from "../workspace-location.js";
import { workStore } from "./work-store.js";
import { interactionService } from "./interaction-service.js";
import { initializeGoal } from "./goal-control.js";
import type { AgentSession, CreateSessionRequest } from "./contracts.js";
import {
  rebuildSessionPermissionRules,
  seedSessionPermissionMetadata,
} from "./session-permissions.js";
import { agentContextBuilder } from "./context-builder.js";
import { agentEventService, type AgentEventService } from "./event-service.js";
import { agentLoopRuntime } from "./loop-runtime.js";
import { sessionProcessManager } from "./session-process-manager.js";
import { profileService, type ProfileService } from "./profile-service.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { AgentValidationError } from "./runtime-errors.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { sessionHooks } from "./session-hooks.js";
import { resolveInitialSessionTitle } from "./session-title-service.js";
import { logger } from "../../lib/logger.js";
import { getProjectSettings } from "../../lib/config/project-settings-store.js";

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
      "[agent-session] creating session…",
    );

    const parent = input.parentSessionId
      ? this.store.getSession(input.parentSessionId)
      : undefined;
    if (parent && versionedSession(parent.id))
      throw new AgentValidationError("Subagents are not yet supported by versioned history. Use a separate session instead.");
    const seenAncestors = new Set<string>();
    for (
      let ancestor = parent;
      ancestor && !seenAncestors.has(ancestor.id);
      ancestor = ancestor.parentSessionId
        ? this.store.getSession(ancestor.parentSessionId)
        : undefined
    ) {
      seenAncestors.add(ancestor.id);
      if (
        ancestor.sessionMetadata?.runtimeControl ||
        ["interrupted", "cancelled"].includes(ancestor.status)
      )
        throw new AgentValidationError(
          "Cannot create a subagent while its ancestor is stopped or stopping.",
        );
    }
    if (input.profileId === 'git-manager' && input.backendId && input.backendId !== 'native') {
      throw new AgentValidationError('Git manager requires the scoped native tool runtime.');
    }
    validateBackendTurnInput(input.backendId ?? "native", input);
    const profile = this.profiles.assertCanStart(input.profileId, {
      parentSessionId: input.parentSessionId,
    });
    if (parent && parent.projectId !== input.projectId) {
      throw new AgentValidationError(
        "Sub-session projectId must match parent session projectId.",
      );
    }
    if (
      input.backendId &&
      input.backendId !== "native" &&
      (input.skillIds?.length || input.mcpServerIds?.length)
    ) {
      throw new AgentValidationError(
        "Synax Skills/MCP selection is not yet supported by this backend. Configure native backend tools separately.",
      );
    }
    const createdAt = nowIso();
    const projectMcpServerIds =
      input.backendId && input.backendId !== "native"
        ? []
        : (input.mcpServerIds ??
          (() => {
            try {
              return getProjectSettings(input.projectId)
                .mcpServers.filter((server) => server.enabled !== false)
                .map((server) => server.id);
            } catch {
              return [];
            }
          })());
    const sessionMetadata = seedSessionPermissionMetadata(
      normalizeSessionPromptMetadata(input.sessionMetadata),
      {
        permissionTier:
          input.permissionTier ??
          (input.profileId === "synax" ? "boundary" : undefined),
        permissionOverrides: input.permissionOverrides,
      },
    );
    const parentBackend = parent?.sessionMetadata?.backend as
      | {
          workDir?: string | null;
          workspaceLocation?: WorkspaceLocation;
          workspaceRoots?: ProjectWorkspaceRoot[];
        }
      | undefined;
    const requestedWorkDir = input.workDir ?? parentBackend?.workDir ?? null;
    if (
      parent &&
      sessionMetadata.gitWorkspace === undefined &&
      parent.sessionMetadata?.gitWorkspace !== undefined
    ) {
      sessionMetadata.gitWorkspace = parent.sessionMetadata.gitWorkspace;
    }
    delete sessionMetadata.runtimeControl;
    const backend = makeBackendBinding(
      input.backendId ?? "native",
      input.model,
      requestedWorkDir ? resolveWorkspaceRoot(requestedWorkDir) : null,
    );
    const requestedLocation =
      (input.sessionMetadata?.workspaceLocation as
        | WorkspaceLocation
        | undefined) ??
      (input.workDir ? undefined : parentBackend?.workspaceLocation);
    if (requestedLocation) backend.workspaceLocation = requestedLocation;
    if (parentBackend?.workspaceRoots) {
      backend.workspaceRoots = parentBackend.workspaceRoots.map((root) => ({
        ...root,
        ...(root.role === "primary" && backend.workDir
          ? {
              path: backend.workspaceLocation?.path ?? backend.workDir,
              ...(backend.workspaceLocation
                ? { location: backend.workspaceLocation }
                : {}),
            }
          : {}),
      }));
    }
    sessionMetadata.backend = backend;
    if (
      !parent &&
      (input.profileId === "synax" || input.profileId === "goal")
    ) {
      delete sessionMetadata.plan;
      delete sessionMetadata.goal;
      if (sessionMetadata.mode === "goal")
        sessionMetadata.goal = initializeGoal(
          resolveSessionUserRequest(
            { prompt: input.prompt, sessionMetadata },
            input.prompt,
          ),
        );
    }
    const sessionDraft: AgentSession = {
      id: makeRuntimeId("ars"),
      projectId: input.projectId,
      parentSessionId: input.parentSessionId ?? null,
      childSessionIds: [],
      nodeId: input.nodeId ?? null,
      profileId: profile.id,
      status: "running",
      title: resolveInitialSessionTitle({
        sessionMetadata,
        prompt: input.prompt,
      }),
      prompt: input.prompt,
      contextSnapshotId: null,
      thinkingMode: input.thinkingMode ?? profile.defaultThinkingMode,
      reasoningEffort: input.reasoningEffort ?? null,
      permissionRules: [],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      resultSummary: null,
      blockedReason: null,
      skillIds: input.skillIds ?? [],
      mcpServerIds: projectMcpServerIds,
      activeRunId: null,
      pendingResumeToken: null,
      sessionMetadata,
    };
    const session: AgentSession = {
      ...sessionDraft,
      permissionRules: rebuildSessionPermissionRules(
        sessionDraft,
        profile.permissionDefaults,
      ),
    };
    const saved = getRawSqlite().transaction(() => {
      const saved = this.store.createSession(session);
      if (!parent && (!input.backendId || input.backendId === "native") && process.env.SYNAX_VERSION_HISTORY !== "legacy")
        initializeFreshVersionNative(saved);
      return saved;
    })();
    const bundle = agentContextBuilder.build(input.projectId, {
      nodeId: input.nodeId ?? undefined,
      profileId: profile.id,
      sessionId: saved.id,
    });
    this.store.updateSession(saved.id, {
      contextSnapshotId: bundle.id,
      updatedAt: nowIso(),
    });
    this.events.append({
      sessionId: saved.id,
      type: "session_started",
      summary: `${profile.label} session started`,
      payload: {
        profileId: profile.id,
        parentSessionId: saved.parentSessionId,
        contextSnapshotId: bundle.id,
      },
    });
    if (parent) {
      this.events.append({
        sessionId: parent.id,
        type: "subsession_started",
        summary: `Started ${profile.label} sub-session`,
        payload: {
          childSessionId: saved.id,
          profileId: profile.id,
          inheritedPermission: true,
        },
      });
    }
    const created = this.store.getSession(saved.id);
    void sessionHooks.emit({ type: "session:created", session: created });
    logger.info(
      {
        sessionId: created.id,
        projectId: created.projectId,
        profileId: created.profileId,
        parentSessionId: created.parentSessionId,
        title: created.title,
        durationMs: Date.now() - started,
      },
      "[agent-session] session created",
    );
    return created;
  }

  get(sessionId: string): AgentSession {
    return this.store.getSession(sessionId);
  }

  list(filter: {
    projectId?: string;
    nodeId?: string;
    status?: string;
    limit?: number;
  }): AgentSession[] {
    return this.store.listSessions(filter);
  }

  listSessionTree(sessionId: string): AgentSession[] {
    return this.store.listSessionTree(sessionId);
  }

  cancel(sessionId: string): AgentSession {
    const tree = this.store.listSessionTree(sessionId);
    const targets = tree.filter(
      (session) =>
        session.id === sessionId ||
        session.activeRunId ||
        session.sessionMetadata?.runtimeControl ||
        [
          "queued",
          "running",
          "waiting_permission",
          "waiting_input",
          "interrupted",
          "cancelled",
        ].includes(session.status),
    );
    const ids = targets.map((session) => session.id);
    agentLoopRuntime.interruptSessions(ids, "User stopped run.");
    sessionProcessManager.interruptSessions(ids, "User stopped run.");
    for (const session of targets) this.cancelOne(session.id);
    return this.store.getSession(sessionId);
  }

  private cancelOne(sessionId: string): void {
    this.store.updateSessionMetadata(sessionId, {
      manualStop: { at: nowIso(), reason: "Stopped by user." },
    });
    const work = workStore.current(sessionId);
    if (work && work.status !== "completed") {
      work.status = "cancelled";
      work.reason = "Stopped by user.";
      workStore.save(work);
    }
    interactionService.cancel(sessionId);
    const existingGoal = this.store.getSession(sessionId).sessionMetadata?.goal;
    if (existingGoal && typeof existingGoal === "object")
      this.store.updateSessionMetadata(sessionId, {
        goal: {
          ...existingGoal,
          status: "cancelled",
          reason: "Stopped by user.",
        },
      });
    const current = this.store.getSession(sessionId);
    const now = nowIso();
    const reason = "User stopped run.";

    for (const run of this.store
      .listRuns(sessionId)
      .filter(
        (run) =>
          run.id === current.activeRunId ||
          ["queued", "running", "waiting_permission", "waiting_input"].includes(
            run.status,
          ),
      )) {
      this.store.updateRun(run.id, {
        status: "interrupted",
        completedAt: now,
        stopReason: reason,
      });
      for (const step of this.store.listRunSteps(run.id)) {
        if (!step.completedAt) {
          this.store.updateRunStep(step.id, {
            status: "cancelled",
            completedAt: now,
            finishReason: "cancelled",
          });
        }
      }
    }
    this.store.updateSession(sessionId, {
      status: "interrupted",
      updatedAt: now,
      completedAt: null,
      resultSummary: reason,
      blockedReason: null,
      activeRunId: null,
      pendingResumeToken: null,
    });
    this.events.append({
      sessionId,
      type: "progress_updated",
      summary: "Session stopped",
      payload: { reason, preservedEvents: true, resumable: true },
    });
  }

  delete(sessionId: string): string[] {
    assertHistoryUnlocked(sessionId);
    return this.store.deleteSessionTree(sessionId);
  }

  archive(sessionId: string) {
    assertHistoryUnlocked(sessionId);
    return this.store.archiveSessionTree(sessionId);
  }
}

export const agentSessionRuntime = new AgentSessionRuntime();
