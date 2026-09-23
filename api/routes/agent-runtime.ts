import { getRawSqlite } from "../db/index.js";
import { upgradeHistory } from "../services/agent-runtime/checkpoints/version-runtime/migrate.js";
import { readHistoryWindow } from "../services/agent-runtime/checkpoints/version-runtime/window.js";
import { boundaryOnlySession,versionRepository,versionedSession } from "../services/agent-runtime/checkpoints/version-runtime/bridge.js";
import { visitConversation } from "../services/agent-runtime/checkpoints/retention.js";
import { planFileUndo } from "../services/agent-runtime/checkpoints/file-plan.js";
import {
  checkpointSummary,
  previewHistory,
  applyHistory,
  recoverHistoryOperation,
  editRunRequestId,
} from "../services/agent-runtime/checkpoints/operations.js";
import { forkCheckpoint } from "../services/agent-runtime/checkpoints/fork.js";
import { getCheckpoint } from "../services/agent-runtime/checkpoints/store.js";
import {
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyRevision,
} from "../services/agent-runtime/checkpoints/guards.js";
import { SNAPSHOT_EXCLUSIONS } from "../services/agent-runtime/checkpoints/files.js";
import { workRuntime } from "../services/agent-runtime/work-runtime.js";
import { workflowMode } from "../services/agent-runtime/workflow-mode.js";
import { compactSessionContext } from "../services/agent-runtime/manual-context-compaction.js";
import { searchSessions } from "../services/agent-runtime/session-search.js";
import {
  validateInputMedia,
  sessionInputCapabilities,
  draftInputCapabilities,
} from "../services/agent-runtime/media-capabilities.js";
import { listTurnReferenceOptions } from "../services/agent-runtime/turn-references.js";
import { backendIdSchema } from "../services/agent-runtime/backends/backend-contracts.js";
import { acknowledgeRuntimeRecovery } from "../services/agent-runtime/runtime-recovery.js";
import {
  AgentRuntimeError,
  AgentValidationError,
} from "../services/agent-runtime/runtime-errors.js";
import {
  projectSessionState,
  projectSessionSummary,
} from "../services/agent-runtime/session-projection.js";
import { randomUUID } from "node:crypto";
import { runCoordinator } from "../services/agent-runtime/run-coordinator.js";
import { runtimeJournal } from "../services/agent-runtime/runtime-journal.js";
import {
  resolveSessionBackend,
  validateBackendTurnInput,
} from "../services/agent-runtime/backends/backend-binding.js";
import {
  describeBackends,
  getBackendAdapter,
} from "../services/agent-runtime/backends/backend-registry.js";
import { workStore } from "../services/agent-runtime/work-store.js";
import { interactionService } from "../services/agent-runtime/interaction-service.js";
import { interactionReplySchema } from "../services/agent-runtime/control-contracts.js";
import { initializeGoal } from "../services/agent-runtime/goal-control.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as z from "zod/v4";
import {
  agentContextBuilder,
  agentEventService,
  agentLoopRuntime,
  agentRuntimeStore,
  agentSessionRuntime,
  buildContextRequestSchema,
  clearInactiveSessionsBodySchema,
  createSessionRequestSchema,
  enqueueInputRequestSchema,
  inputQueueService,
  listEventsQuerySchema,
  listSessionsQuerySchema,
  permissionPolicy,
  permissionReplyRequestSchema,
  profileService,
  resolveSessionCapabilities,
  resolveSessionInvocationUsage,
  streamTurnRequestSchema,
  toHttpError,
  applySessionPermissionUpdate,
  updateSessionPermissionRequestSchema,
} from "../services/agent-runtime/index.js";
import {
  interruptAgentSessionsAndWait,
  closeAcpAgentSessions,
  resumeAgentSessionInBackground,
} from "../services/agent-runtime/agent-stream-proxy.js";
import { acpPermissionBridge } from "../services/agent-runtime/acp-engine/index.js";
import { sessionUsesAcpEngine } from "../services/agent-runtime/acp-engine/index.js";
import { ensureSessionTitleGenerated } from "../services/agent-runtime/session-title-service.js";
import { runtimeBus } from "../services/agent-runtime/runtime-bus.js";
import { sessionLiveBus } from "../services/agent-runtime/session-live-bus.js";
import { logger } from "../lib/logger.js";
import { SseEventType } from "../lib/sse-events.js";
import { assertLlmProviderConfigured } from "../services/llm-runtime/provider-check.js";
import {
  deleteSessionBackgroundProcess,
  listSessionBackgroundProcesses,
  stopSessionBackgroundProcess,
} from "../services/agent-runtime/session-background-processes.js";
import {
  getSessionEnvironment,
  getSessionEnvironmentFile,
  getSessionEnvironmentFileMedia,
  saveSessionEnvironmentFile,
  getSessionInputSourceContent,
  invalidateSessionEnvironment,
} from "../services/agent-runtime/session-environment.js";
import {
  listSessionGitBranches,
  switchSessionGitBranch,
} from "../services/agent-runtime/session-git-branches.js";
import { commitSessionWorkspace } from "../services/agent-runtime/session-git-commit.js";
import { restoreSessionFile } from "../services/agent-runtime/session-git-files.js";
import {
  prepareCommitMessageGeneration,
  streamSessionCommitMessage,
} from "../services/agent-runtime/session-commit-message-stream.js";
import { resolveSessionConfiguredContextLimit } from "../services/agent-runtime/session-context-limit.js";
import {
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
} from "../services/agent-runtime/runtime-protocol.js";
import {
  resolveProjectWorkspaceLocation,
  resolveRegisteredProjectWorkDir,
} from "../services/agent-runtime/tools/workspace.js";
import { workspaceLocationHostPath } from "../services/workspace-location.js";
import {
  GitWorkspaceError,
  resolveGitWorkspaceSelection,
} from "../services/git-workspaces.js";

export const agentRuntimeRoutes = new Hono();
for (const route of ["/sessions/:sessionId", "/sessions/:sessionId/*"]) {
  agentRuntimeRoutes.use(route, async (c, next) => {
    const id = c.req.param("sessionId");
    if (id && getRawSqlite().prepare("SELECT 1 FROM conversation_v3_deletions WHERE session_id=?").get(id))
      return c.json({ error: "Session has been deleted.", code: "NOT_FOUND" }, 404);
    await next();
  });
}

const AGENT_RUNTIME_HEARTBEAT_MS = 10_000;

async function readJson(c: Context) {
  try {
    return { ok: true as const, data: await c.req.json() };
  } catch {
    return { ok: false as const, error: "Invalid JSON body" };
  }
}

function validationError(c: Context, error: z.ZodError) {
  return c.json({ error: "Validation failed", details: error.flatten() }, 400);
}

function runtimeError(c: Context, error: unknown) {
  const mapped = toHttpError(error);
  return c.json(
    mapped.body,
    mapped.status as 400 | 401 | 403 | 404 | 409 | 500,
  );
}

function withSessionPayload(sessionId: string) {
  const session = projectSessionState(agentSessionRuntime.get(sessionId));
  const profile = profileService.getForSession(session);
  return {
    session,
    profile,
    work: workStore.current(sessionId),
    context: session.contextSnapshotId
      ? agentRuntimeStore.getContextBundle(session.contextSnapshotId)
      : null,
  };
}

// Provider-pipeline metadata kept in step rows for debugging; none of it has a
// timeline consumer (the UI reads reasoningEffort and ids/status fields only).
const STEP_METADATA_WIRE_OMISSIONS = [
  "$.protocol",
  "$.usage",
  "$.contextMemorySegment",
  "$.reasoningParts",
  "$.providerMetadata",
  "$.toolCallProviderMetadata",
  "$.runtimeReminder",
] as const;

function projectRunStepForWire<
  T extends { metadata: Record<string, unknown> | null },
>(step: T): T {
  if (!step.metadata) return step;
  let omitted = false;
  const metadata: Record<string, unknown> = { ...step.metadata };
  for (const key of STEP_METADATA_WIRE_OMISSIONS) {
    const name = key.slice(2);
    if (name in metadata) {
      delete metadata[name];
      omitted = true;
    }
  }
  return omitted ? { ...step, metadata } : step;
}

/** Full tool outputs are debug data; only webSearch renders them inline. */
function projectToolCallForWire<
  T extends { toolId: string; outputRef?: unknown },
>(toolCall: T): T {
  if (toolCall.toolId === "webSearch" || toolCall.outputRef === undefined)
    return toolCall;
  const { outputRef: _omitted, ...rest } = toolCall;
  return rest as T;
}

agentRuntimeRoutes.get("/protocol", (c) =>
  c.json({
    protocol: RUNTIME_PROTOCOL_VERSION,
    schema: RUNTIME_PROTOCOL_SCHEMA,
    transports: ["http-json", "sse", "jsonl-rpc"],
    operations: [
      "assets.upload",
      "assets.get",
      "assets.delete",
      "sessions.inputCapabilities",
      "backends.list",
      "projects.list",
      "sessions.list",
      "sessions.get",
      "sessions.create",
      "runs.submit",
      "runs.watch",
      "permissions.reply",
      "interactions.reply",
      "sessions.cancel",
    ],
  }),
);
agentRuntimeRoutes.get("/backends", (c) =>
  c.json({ protocol: RUNTIME_PROTOCOL_VERSION, items: describeBackends() }),
);
agentRuntimeRoutes.get("/backends/:id/models", async (c) => {
  const id = backendIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return validationError(c, id.error);
  try {
    const backend = getBackendAdapter(id.data);
    return backend.models
      ? c.json(await backend.models())
      : c.json(
          { error: "Use the provider model catalog for this backend." },
          400,
        );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/projects/:projectId/references", async (c) => {
  const parsed = z
    .object({
      kind: z.enum(["skill", "mcp", "file", "wiki"]),
      q: z.string().max(256).default(""),
      sessionId: z.string().optional(),
    })
    .safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({
      items: await listTurnReferenceOptions(
        c.req.param("projectId"),
        parsed.data.kind,
        parsed.data.q,
        parsed.data.sessionId,
      ),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/profiles", (c) =>
  c.json({ items: profileService.list() }),
);

agentRuntimeRoutes.post("/contexts/:projectId", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = buildContextRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json(
      agentContextBuilder.build(c.req.param("projectId"), parsed.data),
      201,
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = createSessionRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const projectLocation = resolveProjectWorkspaceLocation(
      parsed.data.projectId,
    );
    if (
      projectLocation?.kind === "wsl" &&
      parsed.data.backendId &&
      parsed.data.backendId !== "native"
    ) {
      throw new AgentRuntimeError(
        "WSL2 projects currently support only the Synax native backend.",
        "WSL_BACKEND_UNSUPPORTED",
        409,
      );
    }
    if (!parsed.data.backendId || parsed.data.backendId === "native")
      assertLlmProviderConfigured(parsed.data.projectId);
    let createInput = parsed.data;
    if (parsed.data.gitWorkspace) {
      const selected = await resolveGitWorkspaceSelection(
        projectLocation ??
          resolveRegisteredProjectWorkDir(parsed.data.projectId),
        parsed.data.projectId,
        parsed.data.gitWorkspace,
      );
      createInput = {
        ...parsed.data,
        workDir: selected.location
          ? workspaceLocationHostPath(selected.location)
          : selected.workDir,
        sessionMetadata: {
          ...(parsed.data.sessionMetadata ?? {}),
          ...(selected.location
            ? { workspaceLocation: selected.location }
            : {}),
          gitWorkspace: {
            kind: selected.kind,
            branch: selected.branch,
            path: selected.workDir,
          },
        },
      };
    }
    const session = agentSessionRuntime.create(createInput);
    return c.json(withSessionPayload(session.id), 201);
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      return c.json(
        { error: error.message, code: "GIT_WORKSPACE_ERROR" },
        error.status as 400 | 404 | 409 | 500 | 503,
      );
    }
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:id/context/compact", (c) => {
  try {
    return c.json(compactSessionContext(c.req.param("id")));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/search", (c) => {
  const parsed = z
    .object({
      projectId: z.string().min(1).max(128),
      q: z.string().trim().min(1).max(256),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const { projectId, q, limit, offset } = parsed.data;
    const result = searchSessions(projectId, q, limit, offset);
    return c.json({
      ...result,
      items: result.items.map((item) => ({
        ...item,
        session: projectSessionSummary(projectSessionState(item.session)),
      })),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions", (c) => {
  const parsed = listSessionsQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed.error);
  const { limit, offset, status, ...filter } = parsed.data;
  // status filtering, paging and the status histogram are resolved in SQL against
  // the projected runtimeControl state; only the requested page is materialized.
  const page = agentRuntimeStore.listSessionsPage(
    { ...filter, status },
    { limit, offset },
  );
  const items = page.items.map(projectSessionState).map(projectSessionSummary);
  return c.json({
    items,
    totalCount: page.totalCount,
    countByStatus: page.countByStatus,
  });
});

/** Badge counts only need id/status/updatedAt; a dedicated sparse projection
 *  keeps per-project polling payloads at bytes-per-row instead of kilobytes. */
agentRuntimeRoutes.get("/sessions/badges", (c) => {
  const projectIds = (c.req.query("projectIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (projectIds.length === 0) return c.json({ items: [] });
  try {
    return c.json({ items: agentRuntimeStore.listSessionBadges(projectIds) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId", (c) => {
  try {
    return c.json(withSessionPayload(c.req.param("sessionId")));
  } catch (error) {
    return runtimeError(c, error);
  }
});

async function readControl(c: Context) {
  try {
    const text = await c.req.text();
    return z
      .object({ runId: z.string().min(1).optional() })
      .parse(text ? JSON.parse(text) : {});
  } catch {
    throw new AgentValidationError("Invalid control request.");
  }
}

agentRuntimeRoutes.post("/sessions/:sessionId/cancel", async (c) => {
  try {
    const id = c.req.param("sessionId");
    const parentId = agentRuntimeStore.getSession(id).parentSessionId;
    const control = await readControl(c);
    await runCoordinator.interrupt(
      id,
      "User requested session stop.",
      () => {
        agentSessionRuntime.cancel(id);
        for (const session of agentRuntimeStore.listSessionTree(id))
          invalidateSessionEnvironment(session.id);
        if (parentId) invalidateSessionEnvironment(parentId);
      },
      control.runId,
    );
    return c.json(projectSessionState(agentRuntimeStore.getSession(id)));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.delete("/sessions/:sessionId", async (c) => {
  try {
    const id = c.req.param("sessionId");
    const parentId = agentRuntimeStore.getSession(id).parentSessionId;
    const control = await readControl(c);
    let deletedSessionIds: string[] = [];
    await runCoordinator.interrupt(
      id,
      "Session deleted by user.",
      () => {
        deletedSessionIds = agentSessionRuntime.delete(id);
        for (const deletedId of deletedSessionIds)
          invalidateSessionEnvironment(deletedId);
        if (parentId) invalidateSessionEnvironment(parentId);
      },
      control.runId,
    );
    return c.json({ ok: true, deletedSessionIds });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/clear-inactive", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = clearInactiveSessionsBodySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const { projectId } = parsed.data;
    const keep = new Set([
      "running",
      "stopping",
      "waiting_permission",
      "waiting_input",
      "queued",
    ]);

    const allSessions = agentSessionRuntime.list({
      projectId,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const toDelete = allSessions.filter(
      (s) =>
        !keep.has(s.status) &&
        !s.sessionMetadata?.runtimeControl &&
        !runCoordinator.isActive(s.id),
    );

    const toDeleteIds = new Set(toDelete.map((s) => s.id));
    // Only delete roots (sessions whose parent is not also being deleted)
    const roots = toDelete.filter(
      (s) => !s.parentSessionId || !toDeleteIds.has(s.parentSessionId),
    );

    const deletedIds: string[] = [];
    for (const root of roots) {
      const currentTree = agentSessionRuntime.listSessionTree(root.id);
      if (
        currentTree.some(
          (session) =>
            keep.has(projectSessionState(session).status) ||
            session.sessionMetadata?.runtimeControl ||
            runCoordinator.isActive(session.id),
        )
      )
        continue;
      await runCoordinator.interrupt(
        root.id,
        "Inactive session cleared.",
        () => {
          deletedIds.push(...agentSessionRuntime.delete(root.id));
        },
      );
    }

    return c.json({
      ok: true,
      deletedCount: deletedIds.length,
      deletedSessionIds: deletedIds,
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:sessionId/history/upgrade", async (c) => {
  try {
    const body = await c.req.json();
    if (body?.acknowledgeCheckpointReset !== true)
      throw new AgentRuntimeError("Explicit acknowledgement of legacy checkpoint retirement is required.", "VALIDATION_ERROR", 400);
    return c.json(await upgradeHistory(c.req.param("sessionId")));
  } catch (error) { return runtimeError(c, error); }
});

agentRuntimeRoutes.get("/sessions/:sessionId/history-window", (c) => {
  try {
    const id = c.req.param("sessionId");
    agentRuntimeStore.getSession(id);
    if (!versionedSession(id)) throw new AgentRuntimeError("Upgrade history before using version windows.", "HISTORY_MIGRATION_REQUIRED", 409);
    return c.json(readHistoryWindow(id, c.req.query("cursor")));
  } catch (error) { return runtimeError(c, error); }
});

agentRuntimeRoutes.get("/sessions/:sessionId/messages", (c) => {
  try {
    const sessionId=c.req.param("sessionId");
    if(versionedSession(sessionId))return c.json(versionRepository().page(sessionId,"messages",{limit:c.req.query("limit")===undefined?64:Number(c.req.query("limit")),cursor:c.req.query("cursor"),reverse:c.req.query("reverse")==="true",preview:c.req.query("preview")==="true",fields:c.req.query("fields")?.split(",")}));
    return c.json({
      items: agentLoopRuntime.listMessages(c.req.param("sessionId")),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/messages/:messageId/content",(c)=>{
  try{
    const sessionId=c.req.param("sessionId");
    if(!versionedSession(sessionId))return c.json({error:"Content paging requires a versioned session."},409);
    const repo=versionRepository();
    if(Number(c.req.query("cursor")??0)>0&&c.req.query("revision")===undefined)return c.json({error:"Content continuation requires the original revision.",code:"HISTORY_STALE"},409);
    if(c.req.query("revision")!==undefined&&Number(c.req.query("revision"))!==repo.head(sessionId).revision)return c.json({error:"Conversation changed.",code:"HISTORY_STALE"},409);
    return c.json(repo.content(sessionId,"messages",c.req.param("messageId"),"content",Number(c.req.query("cursor")??0),c.req.query("revision")===undefined?undefined:Number(c.req.query("revision"))));
  }catch(error){return runtimeError(c,error);}
});

agentRuntimeRoutes.get("/sessions/:sessionId/runs", (c) => {
  try {
    return c.json({
      items: agentLoopRuntime.listRuns(c.req.param("sessionId")),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId", (c) => {
  try {
    return c.json(
      agentLoopRuntime.getRun(c.req.param("sessionId"), c.req.param("runId")),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId/steps", (c) => {
  try {
    return c.json({
      items: agentLoopRuntime
        .listRunSteps(c.req.param("sessionId"), c.req.param("runId"))
        .map(projectRunStepForWire),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/steps", (c) => {
  try {
    return c.json({
      items: agentRuntimeStore
        .listSessionSteps(c.req.param("sessionId"))
        .map(projectRunStepForWire),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

const submitRunSchema = streamTurnRequestSchema.extend({
  requestId: z.string().trim().min(1).max(128),
  mode: z.enum(["turn", "continue"]).default("turn"),
});

function requireSessionBackendConfig(sessionId: string): void {
  const session = agentSessionRuntime.get(sessionId);
  if (resolveSessionBackend(sessionId).id === "native")
    assertLlmProviderConfigured(session.projectId);
}

function observeRunResponse(
  c: Context,
  sessionId: string,
  runId: string,
  after = 0,
) {
  return streamSSE(c, async (stream) => {
    const observer = new AbortController();
    const detach = () => observer.abort();
    c.req.raw.signal.addEventListener("abort", detach, { once: true });
    stream.onAbort(detach);
    if (c.req.raw.signal.aborted) detach();
    const heartbeat = setInterval(() => {
      if (!observer.signal.aborted)
        void stream
          .writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
          .catch(detach);
    }, AGENT_RUNTIME_HEARTBEAT_MS);
    try {
      for await (const record of runCoordinator.observeRun(
        sessionId,
        runId,
        after,
        observer.signal,
      )) {
        await stream.writeSSE({
          id: String(record.sequence),
          data: JSON.stringify(record.chunk),
        });
      }
      if (!observer.signal.aborted) await stream.writeSSE({ data: "[DONE]" });
    } catch (error) {
      if (!observer.signal.aborted) throw error;
    } finally {
      detach();
      clearInterval(heartbeat);
      c.req.raw.signal.removeEventListener("abort", detach);
    }
  });
}

agentRuntimeRoutes.post("/sessions/:sessionId/runs", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = submitRunSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const sessionId = c.req.param("sessionId");
    requireSessionBackendConfig(sessionId);
    const { requestId, mode, ...input } = parsed.data;
    await validateInputMedia(sessionId, input);
    return c.json(
      runCoordinator.submit(sessionId, input, requestId, mode),
      202,
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId/stream", (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    if (agentRuntimeStore.getRun(runId).sessionId !== sessionId)
      return c.json({ error: "Run not found" }, 404);
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .safeParse(c.req.query("after") ?? "0");
    if (!after.success) return validationError(c, after.error);
    return observeRunResponse(c, sessionId, runId, after.data);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:sessionId/recovery", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  try {
    const id = c.req.param("sessionId");
    await runCoordinator.reconcileFailedStop(id);
    await acknowledgeRuntimeRecovery(id);
    return c.json({
      session: projectSessionState(agentRuntimeStore.getSession(id)),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/snapshot", (c) => {
  try {
    return c.json(runtimeJournal.snapshot(c.req.param("sessionId")));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/stream", (c) => {
  const sessionId = c.req.param("sessionId");
  try {
    agentSessionRuntime.get(sessionId);
  } catch (error) {
    return runtimeError(c, error);
  }
  return streamSSE(c, async (stream) => {
    const observer = new AbortController();
    const detach = () => observer.abort();
    stream.onAbort(detach);
    c.req.raw.signal.addEventListener("abort", detach, { once: true });
    if (c.req.raw.signal.aborted) detach();
    const heartbeat = setInterval(() => {
      if (!observer.signal.aborted)
        void stream
          .writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
          .catch(detach);
    }, AGENT_RUNTIME_HEARTBEAT_MS);
    try {
      const snapshot = runtimeJournal.snapshot(sessionId);
      await stream.writeSSE({
        event: "snapshot",
        id: String(snapshot.cursor),
        data: JSON.stringify(snapshot),
      });
      for await (const record of runtimeJournal.observe(
        sessionId,
        snapshot.cursor,
        observer.signal,
      )) {
        await stream.writeSSE({
          event: "chunk",
          id: String(record.sequence),
          data: JSON.stringify(record),
        });
      }
    } catch (error) {
      if (!observer.signal.aborted) throw error;
    } finally {
      detach();
      clearInterval(heartbeat);
      c.req.raw.signal.removeEventListener("abort", detach);
    }
  });
});

agentRuntimeRoutes.post("/sessions/:sessionId/turns/stream", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = streamTurnRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const id = c.req.param("sessionId");
    requireSessionBackendConfig(id);
    await validateInputMedia(id, parsed.data);
    const accepted = runCoordinator.submit(
      id,
      parsed.data,
      c.req.header("Idempotency-Key") ?? randomUUID(),
    );
    return observeRunResponse(c, id, accepted.run.id);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/events", (c) => {
  if(versionedSession(c.req.param("sessionId")) && !boundaryOnlySession(c.req.param("sessionId"))){
    try{
      if(c.req.query("after"))return c.json({error:"Use the versioned event cursor instead of a legacy event id.",code:"HISTORY_PAGE_REQUIRED"},409);
      return c.json(versionRepository().page(c.req.param("sessionId"),"events",{limit:c.req.query("limit")===undefined?64:Number(c.req.query("limit")),cursor:c.req.query("cursor"),reverse:c.req.query("reverse")==="true",preview:c.req.query("preview")==="true",fields:c.req.query("fields")?.split(",")}));
    }catch(error){return runtimeError(c,error);}
  }
  const parsed = listEventsQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({
      items: agentEventService.list(
        c.req.param("sessionId"),
        parsed.data.after,
      ),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:sessionId/resume/stream", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = streamTurnRequestSchema.safeParse(body.data ?? {});
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const id = c.req.param("sessionId");
    requireSessionBackendConfig(id);
    await validateInputMedia(id, parsed.data);
    const accepted = runCoordinator.submit(
      id,
      parsed.data,
      c.req.header("Idempotency-Key") ?? randomUUID(),
      "continue",
    );
    return observeRunResponse(c, id, accepted.run.id);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/artifacts", (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({
      items: agentRuntimeStore.listArtifacts(c.req.param("sessionId")),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/tool-calls", (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({
      items: agentRuntimeStore
        .listToolCalls(c.req.param("sessionId"))
        .map(projectToolCallForWire),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/processes", (c) => {
  try {
    return c.json({
      items: listSessionBackgroundProcesses(c.req.param("sessionId")),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post(
  "/sessions/:sessionId/processes/:processId/stop",
  async (c) => {
    try {
      await stopSessionBackgroundProcess(
        c.req.param("sessionId"),
        c.req.param("processId"),
      );
      return c.json({
        items: listSessionBackgroundProcesses(c.req.param("sessionId")),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.delete(
  "/sessions/:sessionId/processes/:processId",
  async (c) => {
    try {
      await deleteSessionBackgroundProcess(
        c.req.param("sessionId"),
        c.req.param("processId"),
      );
      return c.json({
        items: listSessionBackgroundProcesses(c.req.param("sessionId")),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.get("/sessions/:sessionId/environment", async (c) => {
  try {
    return c.json(await getSessionEnvironment(c.req.param("sessionId")));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get(
  "/sessions/:sessionId/environment/input-source/:toolCallId",
  (c) => {
    try {
      return c.json(
        getSessionInputSourceContent(
          c.req.param("sessionId"),
          c.req.param("toolCallId"),
        ),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.put("/sessions/:sessionId/environment/file", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      path: z.string().min(1),
      content: z.string(),
      rootId: z.string().min(1).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid file payload" }, 400);
  try {
    return c.json(
      await saveSessionEnvironmentFile(
        c.req.param("sessionId"),
        parsed.data.path,
        parsed.data.content,
        parsed.data.rootId,
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get(
  "/sessions/:sessionId/environment/file/media",
  async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "Missing path" }, 400);
    try {
      const result = await getSessionEnvironmentFileMedia(
        c.req.param("sessionId"),
        filePath,
        c.req.query("rootId"),
      );
      c.header("Content-Type", result.mediaType);
      c.header("Content-Length", String(result.bytes.length));
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(result.path.split("/").pop() ?? "preview")}`,
      );
      return c.body(new Uint8Array(result.bytes));
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.get("/sessions/:sessionId/environment/file", async (c) => {
  const filePath = c.req.query("path");
  const kind = c.req.query("kind") === "input" ? "input" : "diff";
  if (!filePath) return c.json({ error: "Missing path" }, 400);
  try {
    return c.json(
      await getSessionEnvironmentFile(
        c.req.param("sessionId"),
        filePath,
        kind,
        c.req.query("rootId"),
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/git/branches", async (c) => {
  try {
    return c.json(
      await listSessionGitBranches(
        c.req.param("sessionId"),
        c.req.query("rootId"),
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
const switchBranchSchema = z.object({
  branch: z.string().min(1).max(1024),
  rootId: z.string().min(1).optional(),
});
agentRuntimeRoutes.post(
  "/sessions/:sessionId/git/branches/switch",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = switchBranchSchema.safeParse(body.data);
    if (!parsed.success) return validationError(c, parsed.error);
    try {
      return c.json(
        await switchSessionGitBranch(
          c.req.param("sessionId"),
          parsed.data.branch,
          parsed.data.rootId,
        ),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

const commitMessageStreamSchema = z.object({
  rootId: z.string().min(1).optional(),
  model: z.string().trim().min(1).max(256),
});

agentRuntimeRoutes.post(
  "/sessions/:sessionId/git/commit-message/stream",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = commitMessageStreamSchema.safeParse(body.data ?? {});
    if (!parsed.success) return validationError(c, parsed.error);
    let prepared: Awaited<ReturnType<typeof prepareCommitMessageGeneration>>;
    try {
      prepared = await prepareCommitMessageGeneration(
        c.req.param("sessionId"),
        parsed.data,
      );
    } catch (error) {
      return runtimeError(c, error);
    }
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of streamSessionCommitMessage(
          prepared,
          c.req.raw.signal,
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      } catch (error) {
        if (!c.req.raw.signal.aborted) {
          const message =
            error instanceof Error ? error.message : String(error);
          await stream
            .writeSSE({
              data: JSON.stringify({ type: "error", error: message }),
            })
            .catch(() => {});
        }
      } finally {
        if (!c.req.raw.signal.aborted)
          await stream.writeSSE({ data: "[DONE]" }).catch(() => {});
      }
    });
  },
);

const commitSessionWorkspaceSchema = z.object({
  rootId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(2000),
  // Absent means "push after committing" so existing senders keep working.
  push: z.boolean().optional(),
  // Absent means "stage everything" so existing senders keep working.
  includeUntracked: z.boolean().optional(),
});

agentRuntimeRoutes.post("/sessions/:sessionId/git/commit", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = commitSessionWorkspaceSchema.safeParse(body.data ?? {});
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json(
      await commitSessionWorkspace(c.req.param("sessionId"), parsed.data),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

const restoreSessionFileSchema = z.object({
  rootId: z.string().min(1).optional(),
  path: z.string().trim().min(1).max(1024),
});

agentRuntimeRoutes.post(
  "/sessions/:sessionId/git/files/restore",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = restoreSessionFileSchema.safeParse(body.data ?? {});
    if (!parsed.success) return validationError(c, parsed.error);
    try {
      return c.json(
        await restoreSessionFile(c.req.param("sessionId"), parsed.data),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.get("/sessions/:sessionId/stats", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    const session = agentSessionRuntime.get(sessionId);
    // Render the usage bar against the provider-configured context window.
    const configuredContextLimit =
      await resolveSessionConfiguredContextLimit(session);
    const stats = agentRuntimeStore.getSessionStats(sessionId, {
      configuredContextLimit,
    });
    return c.json(stats);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/capabilities", (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    agentSessionRuntime.get(sessionId);
    return c.json(resolveSessionCapabilities(sessionId));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/invocation-usage", (c) => {
  try {
    return c.json(resolveSessionInvocationUsage(c.req.param("sessionId")));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/todos", (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    agentSessionRuntime.get(sessionId);
    // Read only the newest task snapshot: scanning the full event log here
    // blocked the profile panel's polling during long runs.
    const latestTaskEvent = agentRuntimeStore.getLatestEventByType(
      sessionId,
      "task_state_updated",
    );
    const tasks =
      (latestTaskEvent?.payload.tasks as Array<{
        id: string;
        subject: string;
        status: string;
      }>) ?? [];
    const items = tasks
      .filter((t) => t.status !== "deleted")
      .map((t) => ({
        id: t.id,
        label: t.subject,
        status: t.status === "completed" ? "done" : t.status,
      }));
    return c.json({ items });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/permissions", (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({ items: permissionPolicy.list(c.req.param("sessionId")) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.patch("/sessions/:sessionId/permissions", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = updateSessionPermissionRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  const sessionId = c.req.param("sessionId");
  try {
    if (agentSessionRuntime.get(sessionId).sessionMetadata?.runtimeControl)
      return c.json(
        { error: "Wait for execution shutdown before changing permissions." },
        409,
      );
    validateBackendTurnInput(resolveSessionBackend(sessionId).id, parsed.data);
    const session = applySessionPermissionUpdate(sessionId, parsed.data);
    return c.json(withSessionPayload(session.id));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post(
  "/sessions/:sessionId/permissions/:permissionId/reply",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = permissionReplyRequestSchema.safeParse(body.data);
    if (!parsed.success) return validationError(c, parsed.error);
    const sessionId = c.req.param("sessionId");
    try {
      const session = agentRuntimeStore.getSession(sessionId);
      const previous = permissionPolicy
        .list(sessionId)
        .find((item) => item.id === c.req.param("permissionId"));
      if (previous?.resolvedAt) {
        return previous.userReply === parsed.data.reply
          ? c.json(previous)
          : c.json(
              {
                error: "Permission was already resolved differently.",
                code: "PERMISSION_CONFLICT",
              },
              409,
            );
      }
      if (runCoordinator.isStopping(sessionId))
        return c.json({ error: "Execution is stopping." }, 409);
      if (previous?.runId && session.activeRunId !== previous.runId) {
        return c.json(
          {
            error: "This permission no longer belongs to the active execution.",
            code: "PERMISSION_EXPIRED",
          },
          409,
        );
      }
      const backendId = resolveSessionBackend(sessionId).id;
      const backend = getBackendAdapter(backendId);
      if (
        backendId !== "native" &&
        !backend.hasPendingPermission?.(sessionId, c.req.param("permissionId"))
      ) {
        return c.json(
          {
            error: "The native permission request has expired.",
            code: "PERMISSION_EXPIRED",
          },
          409,
        );
      }
      const decision = permissionPolicy.reply(
        sessionId,
        c.req.param("permissionId"),
        parsed.data.reply,
        parsed.data.message,
        backendId === "native",
      );
      if (backendId !== "native") {
        backend.replyPermission?.(sessionId, decision.id, parsed.data.reply);
        return c.json(decision);
      }
      logger.info(
        {
          sessionId,
          permissionId: decision.id,
          reply: parsed.data.reply,
          action: decision.action,
          resumeToken: decision.resumeToken,
        },
        "[agent-runtime] permission reply received",
      );
      agentEventService.append({
        sessionId,
        type: "permission_resolved",
        summary: decision.reason,
        payload: {
          permissionId: decision.id,
          action: decision.action,
          userReply: decision.userReply,
        },
      });
      const permissionEndedSession =
        !decision.resumeToken && decision.action !== "allow";
      const permissionResolvedAt = new Date().toISOString();
      agentRuntimeStore.updateSession(sessionId, {
        status: permissionEndedSession ? "completed" : "running",
        updatedAt: permissionResolvedAt,
        pendingResumeToken: decision.resumeToken,
        blockedReason: permissionEndedSession ? decision.reason : null,
        resultSummary: permissionEndedSession ? decision.reason : null,
        ...(permissionEndedSession
          ? { activeRunId: null, completedAt: permissionResolvedAt }
          : { completedAt: null }),
      });
      if (decision.resumeToken && !sessionUsesAcpEngine(sessionId)) {
        logger.info(
          {
            sessionId,
            permissionId: decision.id,
            resumeToken: decision.resumeToken,
          },
          "[agent-runtime] scheduling run resume after permission reply",
        );
        resumeAgentSessionInBackground(
          sessionId,
          parsed.data.message ? { message: parsed.data.message } : {},
        );
      }
      return c.json(decision);
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.get("/sessions/:sessionId/input-queue", (c) => {
  try {
    return c.json({ items: inputQueueService.list(c.req.param("sessionId")) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:sessionId/input-queue", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = enqueueInputRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    await validateInputMedia(c.req.param("sessionId"), parsed.data);
    const sessionId = c.req.param("sessionId");
    inputQueueService.enqueue(sessionId, parsed.data);
    // The active run may have completed while media validation was in flight.
    runCoordinator.dispatchQueuedInput(sessionId);
    return c.json({ items: inputQueueService.list(sessionId) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.patch(
  "/sessions/:sessionId/input-queue/:itemId/order",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const payload = (body.data ?? {}) as {
      direction?: unknown;
      toIndex?: unknown;
    };
    if (payload.direction === undefined && payload.toIndex === undefined)
      return c.json({ error: "Provide direction (up/down) or toIndex." }, 400);
    if (payload.direction !== undefined && payload.toIndex !== undefined)
      return c.json(
        { error: "Provide either direction or toIndex, not both." },
        400,
      );
    if (
      payload.direction !== undefined &&
      payload.direction !== "up" &&
      payload.direction !== "down"
    )
      return c.json({ error: "Direction must be up or down." }, 400);
    if (
      payload.toIndex !== undefined &&
      (typeof payload.toIndex !== "number" ||
        !Number.isInteger(payload.toIndex))
    )
      return c.json({ error: "toIndex must be an integer." }, 400);
    try {
      return c.json({
        items: inputQueueService.move(
          c.req.param("sessionId"),
          c.req.param("itemId"),
          payload.direction !== undefined
            ? { direction: payload.direction }
            : { toIndex: payload.toIndex as number },
        ),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

agentRuntimeRoutes.delete("/sessions/:sessionId/input-queue/:itemId", (c) => {
  try {
    const items = inputQueueService.remove(
      c.req.param("sessionId"),
      c.req.param("itemId"),
    );
    return c.json({ items });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post(
  "/sessions/:sessionId/input-queue/:itemId/force",
  (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      inputQueueService.markForceInject(sessionId, c.req.param("itemId"));
      runCoordinator.dispatchQueuedInput(sessionId);
      return c.json({
        items: inputQueueService.list(sessionId),
        forceInjectItemId: inputQueueService.getForceInjectId(sessionId),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);

// ============================== SSE 事件流 =======================
agentRuntimeRoutes.get("/events/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;

    const onEvent = (event: {
      type: string;
      sessionId: string;
      patch?: Record<string, unknown>;
    }) => {
      if (closed) return;
      const current =
        event.patch &&
        ("status" in event.patch ||
          "activeRunId" in event.patch ||
          "sessionMetadata" in event.patch)
          ? agentRuntimeStore.tryGetSession(event.sessionId)
          : undefined;
      const projected = current ? projectSessionState(current) : undefined;
      const wire = projected
        ? {
            ...event,
            patch: {
              ...event.patch,
              status: projected.status,
              activeRunId: projected.activeRunId,
            },
          }
        : event;
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(wire) })
        .catch(() => {
          closed = true;
        });
    };

    const unsubscribe = runtimeBus.subscribe(onEvent);

    await stream.writeSSE({ event: SseEventType.Connected, data: "{}" });

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream
        .writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
        .catch(() => {
          closed = true;
        });
    }, 25_000);

    c.req.raw.signal.addEventListener("abort", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});

agentRuntimeRoutes.get("/sessions/:sessionId/live", (c) => {
  const sessionId = c.req.param("sessionId");
  try {
    agentSessionRuntime.get(sessionId);
  } catch (error) {
    return runtimeError(c, error);
  }
  return streamSSE(c, async (stream) => {
    let closed = false;

    const onEvent = (event: { type: string; stepId: string }) => {
      if (closed) return;
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => {
          closed = true;
        });
    };

    const unsubscribe = sessionLiveBus.subscribe(sessionId, onEvent);

    await stream.writeSSE({ event: SseEventType.Connected, data: "{}" });

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream
        .writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
        .catch(() => {
          closed = true;
        });
    }, 25_000);

    c.req.raw.signal.addEventListener("abort", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});

// Forms are durable resources, not permission grants or queued chat messages.
agentRuntimeRoutes.get("/sessions/:sessionId/interactions", (c) => {
  try {
    return c.json({
      interactions: interactionService.list(c.req.param("sessionId")),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post(
  "/sessions/:sessionId/interactions/:interactionId/reply",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = interactionReplySchema.safeParse(body.data);
    if (!parsed.success) return validationError(c, parsed.error);
    try {
      const sessionId = c.req.param("sessionId");
      if (
        agentRuntimeStore.getSession(sessionId).sessionMetadata?.runtimeControl
      )
        return c.json(
          { error: "Execution is stopping or requires recovery." },
          409,
        );
      const backendId = resolveSessionBackend(sessionId).id,
        backend = getBackendAdapter(backendId);
      const id = c.req.param("interactionId");
      const previous = interactionService
        .list(sessionId)
        .find((item) => item.id === id);
      if (
        backendId !== "native" &&
        previous?.status === "pending" &&
        !backend.hasPendingInteraction?.(sessionId, id)
      )
        return c.json({ error: "Native input request expired." }, 409);
      const interaction = interactionService.reply(sessionId, id, parsed.data);
      if (backendId === "native") {
        if (interactionService.ready(sessionId))
          resumeAgentSessionInBackground(sessionId);
      } else backend.replyInteraction?.(sessionId, id);
      return c.json({ interaction });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.patch("/sessions/:sessionId/mode", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({ mode: z.enum(["chat", "plan", "goal"]) })
    .strict()
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const id = c.req.param("sessionId"),
      session = agentRuntimeStore.getSession(id);
    if (
      session.parentSessionId ||
      !["synax", "goal"].includes(session.profileId) ||
      sessionUsesAcpEngine(id)
    )
      return c.json(
        { error: "Modes are only available on primary native Synax sessions." },
        400,
      );
    if (
      session.sessionMetadata?.runtimeControl ||
      session.activeRunId ||
      ["running", "waiting_input", "waiting_permission"].includes(
        session.status,
      ) ||
      interactionService.pending(id)
    )
      return c.json(
        {
          error:
            "Stop the run and resolve any input form before switching mode.",
        },
        409,
      );
    const mode = parsed.data.mode;
    const updated = agentRuntimeStore.updateSessionMetadata(id, {
      mode,
      ...(mode === "goal" && !session.sessionMetadata?.goal
        ? { goal: initializeGoal(session.prompt) }
        : {}),
    });
    workRuntime.onModeChanged(id, workflowMode(session));
    return c.json({ session: updated });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/sessions/:sessionId/input-capabilities", async (c) => {
  try {
    return c.json(
      await sessionInputCapabilities(
        c.req.param("sessionId"),
        c.req.query("model"),
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get("/input-capabilities", async (c) => {
  const parsed = z
    .object({
      projectId: z.string().min(1),
      backendId: backendIdSchema.default("native"),
      model: z.string().optional(),
    })
    .safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json(
      await draftInputCapabilities(
        parsed.data.projectId,
        parsed.data.backendId,
        parsed.data.model,
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});

// Conversation history operations are deliberately separate from work.checkpoint.
const historyActionSchema = z.object({
  checkpointId: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(128),
  message: z.string().trim().min(1).max(100_000).optional(),
  includeFiles: z.boolean().default(true),
});
agentRuntimeRoutes.get("/sessions/:sessionId/checkpoints", (c) => {
  try {
    return c.json(checkpointSummary(c.req.param("sessionId")));
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post("/sessions/:sessionId/history/preview", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({
      checkpointId: z.string().min(1),
      action: z.enum(["rollback", "edit", "fork"]),
      includeFiles: z.boolean().default(true),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const sessionId = c.req.param("sessionId");
    if (parsed.data.action !== "fork")
      return c.json(await previewHistory(sessionId, parsed.data.checkpointId, parsed.data.includeFiles));
    assertHistoryUnlocked(sessionId);
    assertHistoryIdle(sessionId);
    const checkpoint = getCheckpoint(sessionId, parsed.data.checkpointId);
    if (checkpoint.kind !== "reply" || checkpoint.payload.version !== 2) throw new AgentValidationError("A reply boundary is required.");
    const plan = await planFileUndo(checkpoint, parsed.data.includeFiles);
    return c.json({ checkpointId: checkpoint.id, revision: historyRevision(sessionId), removedMessages: 0,
      files: plan.changes.map(c => ({root:c.root,path:c.path,action:c.before ? "restore" : "delete"})),
      conflicts: plan.conflicts, warnings: [...plan.warnings, "Fork copies the current workspace on demand; unrelated files retain their current versions."], preservedFiles: plan.preservedFiles,
      exclusions: SNAPSHOT_EXCLUSIONS, canApply: !plan.conflicts.length });
  } catch (error) {
    return runtimeError(c, error);
  }
});
for (const action of ["rollback", "edit", "fork"] as const) {
  agentRuntimeRoutes.post(
    `/sessions/:sessionId/history/${action}`,
    async (c) => {
      const body = await readJson(c);
      if (!body.ok) return c.json({ error: body.error }, 400);
      const parsed = historyActionSchema.safeParse(body.data);
      if (!parsed.success) return validationError(c, parsed.error);
      try {
        const sessionId = c.req.param("sessionId"),
          input = parsed.data;
        if (action === "fork")
          return c.json(
            await forkCheckpoint(
              sessionId,
              input.checkpointId,
              input.revision,
              input.requestId,
              input.includeFiles,
            ),
            201,
          );
        if (action === "edit") requireSessionBackendConfig(sessionId);
        const result = await applyHistory(sessionId, { ...input, action });
        if (
          result.input &&
          result.runId &&
          historyRevision(sessionId) === result.revision
        )
          runCoordinator.submit(
            sessionId,
            result.input,
            editRunRequestId(sessionId, input.requestId),
            "turn",
          );
        return c.json({
          sessionId: result.sessionId,
          revision: result.revision,
          runId: result.runId,
        });
      } catch (error) {
        return runtimeError(c, error);
      }
    },
  );
}
agentRuntimeRoutes.post("/sessions/:sessionId/history/recover", async (c) => {
  try {
    await recoverHistoryOperation(c.req.param("sessionId"));
    return c.json({ recovered: true });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post("/sessions/:sessionId/history/visit", c => {
  try { visitConversation(c.req.param("sessionId")); return c.json({visited:true}); }
  catch(error) { return runtimeError(c,error); }
});
