import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { assertLlmProviderConfigured } from "../../infrastructure/llm-runtime/provider-check.js";
import {
  getGlobalConfig,
  getGlobalConfigForRuntime,
} from "../../infrastructure/runtime/config/config-store.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { observationLifetime } from "../../infrastructure/runtime/observation-lifetime.js";
import { SseEventType } from "../../infrastructure/runtime/sse-events.js";
import { sessionUsesAcpEngine } from "../../modules/agent-runtime/acp-engine/index.js";
import {
  closeAcpAgentSessions,
  resumeAgentSessionInBackground,
} from "../../modules/agent-runtime/agent-stream-proxy.js";
import {
  resolveSessionBackend,
  validateBackendTurnInput,
} from "../../modules/agent-runtime/backends/backend-binding.js";
import { backendIdSchema } from "../../modules/agent-runtime/backends/backend-contracts.js";
import {
  describeBackends,
  getBackendAdapter,
} from "../../modules/agent-runtime/backends/backend-registry.js";
import type {
  AgentRun,
  AgentRuntimeMessage,
  AgentSession,
  CreateSessionRequest,
  PermissionDecision,
  RuntimeEvent,
  ToolCallRecord,
} from "../../modules/agent-runtime/contracts.js";
import { interactionReplySchema } from "../../modules/agent-runtime/control-contracts.js";
import { initializeGoal } from "../../modules/agent-runtime/goal-control.js";
import {
  agentContextBuilder,
  agentRuntimeStore,
  agentSessionRuntime,
  applySessionPermissionUpdateAuthoritative,
  buildContextRequestSchema,
  clearInactiveSessionsBodySchema,
  createSessionRequestSchema,
  enqueueInputRequestSchema,
  listEventsQuerySchema,
  listSessionsQuerySchema,
  permissionReplyRequestSchema,
  profileService,
  resolveSessionCapabilities,
  resolveSessionInvocationUsageFromRecords,
  streamTurnRequestSchema,
  toHttpError,
  updateSessionPermissionRequestSchema,
} from "../../modules/agent-runtime/index.js";
import {
  MAX_OPTIMIZATION_INPUT_CHARS,
  optimizeInput,
} from "../../modules/agent-runtime/input-optimization.js";
import { inputQueueRuntime } from "../../modules/agent-runtime/input-queue-runtime.js";
import { interactionService } from "../../modules/agent-runtime/interaction-service.js";
import {
  draftInputCapabilities,
  sessionInputCapabilities,
  validateInputMedia,
} from "../../modules/agent-runtime/media-capabilities.js";
import { restorePlanArtifact } from "../../modules/agent-runtime/plan-artifact-store.js";
import {
  listProjectToolGrants,
  revokeProjectToolGrant,
} from "../../modules/agent-runtime/project-tool-grants.js";
import { runCoordinator } from "../../modules/agent-runtime/run-coordinator.js";
import { runtimeBus } from "../../modules/agent-runtime/runtime-bus.js";
import {
  AgentNotFoundError,
  AgentRuntimeError,
  AgentValidationError,
} from "../../modules/agent-runtime/runtime-errors.js";
import { withSessionEventsQuiesced } from "../../modules/agent-runtime/runtime-event-quiesce.js";
import { runtimeJournal } from "../../modules/agent-runtime/runtime-journal.js";
import {
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
} from "../../modules/agent-runtime/runtime-protocol.js";
import { acknowledgeRuntimeRecovery } from "../../modules/agent-runtime/runtime-recovery.js";
import {
  deleteSessionBackgroundProcess,
  listSessionBackgroundProcesses,
  stopSessionBackgroundProcess,
  stopSessionBackgroundProcesses,
} from "../../modules/agent-runtime/session-background-processes.js";
import {
  prepareCommitMessageGeneration,
  streamSessionCommitMessage,
} from "../../modules/agent-runtime/session-commit-message-stream.js";
import { resolveSessionConfiguredContextLimit } from "../../modules/agent-runtime/session-context-limit.js";
import {
  getSessionEnvironment,
  getSessionEnvironmentFile,
  getSessionEnvironmentFileMedia,
  getSessionInputSourceContentFromRecord,
  invalidateSessionEnvironment,
  openSessionFileInSystemTerminal,
  renameSessionEnvironmentFile,
  saveSessionEnvironmentFile,
  trashSessionEnvironmentFile,
} from "../../modules/agent-runtime/session-environment.js";
import {
  createSessionGitBranch,
  listSessionGitBranches,
  switchSessionGitBranch,
} from "../../modules/agent-runtime/session-git-branches.js";
import {
  commitSessionWorkspace,
  pushSessionWorkspace,
} from "../../modules/agent-runtime/session-git-commit.js";
import { restoreSessionFile } from "../../modules/agent-runtime/session-git-files.js";
import {
  sessionLiveBus,
  type SessionLiveEvent,
} from "../../modules/agent-runtime/session-live-bus.js";
import { sessionProcessManager } from "../../modules/agent-runtime/session-process-manager.js";
import {
  projectSessionState,
  projectSessionSummary,
} from "../../modules/agent-runtime/session-projection.js";
import { runtimeFacade } from "../../modules/agent-runtime/sidecar/runtime-facade.js";
import { RuntimeSidecarError } from "../../modules/agent-runtime/sidecar/sidecar-client.js";
import {
  resolveProjectWorkspaceLocation,
  resolveRegisteredProjectWorkDir,
} from "../../modules/agent-runtime/tools/workspace.js";
import { listTurnReferenceOptions } from "../../modules/agent-runtime/turn-references.js";
import { hydrateCompletedVisualizations } from "../../modules/agent-runtime/visualization-integration.js";
import { workRuntime } from "../../modules/agent-runtime/work-runtime.js";
import { workflowMode } from "../../modules/agent-runtime/workflow-mode.js";
import {
  GitWorkspaceError,
  resolveGitWorkspaceSelection,
} from "../../modules/git-workspaces.js";
import {
  discoverOpenRouterModels,
  findMediaModel,
  mediaModels,
} from "../../modules/media/catalog.js";
import {
  cancelJob,
  createMediaJob,
  getMediaJob,
  listMediaJobs,
} from "../../modules/media/jobs.js";
import { mediaJobInputSchema } from "../../modules/media/schema.js";
import {
  projectWorkspaceRoots,
  readWorkspaceProject,
  workspaceRootLocation,
} from "../../modules/project-workspace.js";
import { workspaceLocationHostPath } from "../../modules/workspace-location.js";
export const agentRuntimeRoutes = new Hono();
// Load the execution working set at the HTTP boundary, and acknowledge only
// after all mutations have reached Rust.
agentRuntimeRoutes.use('*', async (c, next) => {
  const id = c.req.param('sessionId') ?? (c.req.path.startsWith('/sessions/') ? c.req.param('id') : undefined);
  try {
    await agentRuntimeStore.hydrateSessions();
    if (id) await agentRuntimeStore.hydrateSession(id);
    await next();
    await agentRuntimeStore.flush();
  } catch (error) { return runtimeError(c, error); }
});

const authoritativeEditRequestId = (sessionId: string, requestId: string) =>
  `history_${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex")}`;
agentRuntimeRoutes.get("/projects/:projectId/tool-grants", (c) => {
  try {
    return c.json({ items: listProjectToolGrants(c.req.param("projectId")) });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.delete("/projects/:projectId/tool-grants/:toolId", (c) => {
  try {
    const removed = revokeProjectToolGrant(
      c.req.param("projectId"),
      c.req.param("toolId"),
    );
    return removed
      ? c.json({ revoked: true })
      : c.json({ error: "Tool grant not found." }, 404);
  } catch (error) {
    return runtimeError(c, error);
  }
});
for (const route of ["/sessions/:sessionId", "/sessions/:sessionId/*"]) {
  agentRuntimeRoutes.use(route, async (c, next) => {
    const id = c.req.param("sessionId");
    if (id) {
      {
        try {
          const projected = projectSessionState(
            (await runtimeFacade.uiSnapshotAuthoritative(id)).session as never,
          );
          if (
            projected.sessionMetadata?.archivedAt ||
            projected.sessionMetadata?.deletedAt
          )
            return runtimeError(c, new AgentNotFoundError(id));
        } catch (error) {
          if (
            error instanceof RuntimeSidecarError &&
            error.code === "PROJECTION_MISSING"
          )
            return runtimeError(c, new AgentNotFoundError(id));
          return runtimeError(c, error);
        }
      }
    }
    await next();
  });
}
const AGENT_RUNTIME_HEARTBEAT_MS = 10000;
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
async function archiveSessionAfterShutdown(
  sessionId: string,
  expectedRunId?: string,
): Promise<{
  archiveBatchId: string;
  archivedAt: string;
  archivedSessionIds: string[];
  parentId: string | null;
}> {
  const parentId = agentRuntimeStore.getSession(sessionId).parentSessionId;
  const sessionIds = agentSessionRuntime
    .listSessionTree(sessionId)
    .map((session) => session.id);
  // Archiving is a lifecycle operation, not just a visibility mutation. Stop the
  // active runtime, ACP sessions, and every owned background process first;
  // then mark the whole subtree stopped before hiding it. The shutdown pipeline
  // runs inside a quiesce scope: its intermediate events (stopping flags,
  // cancelled steps, interrupted runs) are dropped at the bus boundary and
  // clients learn about the operation solely through the terminal
  // `session_archived` events the archive itself emits.
  return withSessionEventsQuiesced(sessionIds, async () => {
    await runCoordinator.interrupt(
      sessionId,
      "Session archived by user.",
      undefined,
      expectedRunId,
    );
    await closeAcpAgentSessions(sessionIds);
    await stopSessionBackgroundProcesses(sessionIds);
    {
      await Promise.all(
        sessionIds.map((id) =>
          runtimeFacade.stopSessionAuthoritative(
            id,
            "interrupted",
            "Session archived by user.",
          ),
        ),
      );
    }
    return { ...agentSessionRuntime.archive(sessionId), parentId };
  });
}
const inputOptimizationSchema = z
  .object({
    projectId: z.string().trim().min(1).max(256),
    text: z
      .string()
      .min(1)
      .max(MAX_OPTIMIZATION_INPUT_CHARS)
      .refine((text) => Boolean(text.trim())),
    model: z.string().trim().min(1).max(512).optional(),
    backendId: backendIdSchema.optional(),
  })
  .strict();
agentRuntimeRoutes.post("/input/optimize", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = inputOptimizationSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  if (c.req.header("accept")?.includes("text/event-stream")) {
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
      try {
        const result = await optimizeInput(
          parsed.data,
          signal,
          async (text) => {
            await stream.writeSSE({
              event: "delta",
              data: JSON.stringify({ text }),
            });
          },
        );
        await stream.writeSSE({
          event: "result",
          data: JSON.stringify(result),
        });
      } catch (error) {
        if (!signal.aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      }
    });
  }
  try {
    return c.json(await optimizeInput(parsed.data, c.req.raw.signal));
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/media/models/discover", async (c) => {
  try {
    const providerId = c.req.query("providerId") ?? "custom-api:openrouter";
    const config = getGlobalConfigForRuntime();
    const connection = config.providerConnections[providerId];
    if (!connection?.apiKey)
      return c.json({ error: "Provider API key is not configured." }, 422);
    if (providerId !== "custom-api:openrouter") return c.json({ models: [] });
    const baseUrl = connection.baseUrl ?? "https://openrouter.ai/api/v1";
    return c.json({
      models: await discoverOpenRouterModels(baseUrl, connection.apiKey),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/media/models", (c) => {
  try {
    return c.json({ models: mediaModels(getGlobalConfigForRuntime()) });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post("/sessions/:sessionId/media-jobs", async (c) => {
  try {
    const session = agentSessionRuntime.get(c.req.param("sessionId"));
    const body = await c.req.json();
    const parsed = mediaJobInputSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error);
    findMediaModel(
      getGlobalConfigForRuntime(),
      parsed.data.providerId,
      parsed.data.modelId,
    );
    const job = createMediaJob(session.id, session.projectId, parsed.data);
    return c.json({ job }, 202);
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/media-jobs", (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({ jobs: listMediaJobs(c.req.param("sessionId")) });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/media-jobs/:jobId", (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    const job = getMediaJob(c.req.param("jobId"));
    if (!job || job.sessionId !== c.req.param("sessionId"))
      return c.json({ error: "Media job not found." }, 404);
    return c.json({ job });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post(
  "/sessions/:sessionId/media-jobs/:jobId/cancel",
  async (c) => {
    try {
      agentSessionRuntime.get(c.req.param("sessionId"));
      const job = getMediaJob(c.req.param("jobId"));
      if (!job || job.sessionId !== c.req.param("sessionId"))
        return c.json({ error: "Media job not found." }, 404);
      return c.json({ job: await cancelJob(job.id) });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
async function withAuthoritativeSessionPayload(sessionId: string) {
  const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
  const session = projectSessionState(snapshot.session as never);
  const [workItems, contextItems] = await Promise.all([
    runtimeFacade.listHistoryObjects(sessionId, "list_work"),
    runtimeFacade.listHistoryObjects(sessionId, "list_contexts"),
  ]);
  const activeWorkId =
    typeof session.sessionMetadata?.activeWorkId === "string"
      ? session.sessionMetadata.activeWorkId
      : undefined;
  const work =
    (
      workItems as Array<{
        id?: unknown;
        sessionId?: unknown;
        updatedAt?: unknown;
      }>
    )
      .filter(
        (item) =>
          item.sessionId === sessionId &&
          (!activeWorkId || item.id === activeWorkId),
      )
      .sort((a, b) =>
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
      )[0] ?? null;
  const context = session.contextSnapshotId
    ? ((
        contextItems as Array<{
          id?: unknown;
          sessionId?: unknown;
        }>
      ).find(
        (item) =>
          item.id === session.contextSnapshotId && item.sessionId === sessionId,
      ) ?? null)
    : null;
  return {
    session,
    profile: profileService.getForSession(session),
    work,
    context,
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
  T extends {
    metadata: Record<string, unknown> | null;
  },
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
  T extends {
    toolId: string;
    outputRef?: unknown;
  },
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
      kind: z.enum(["skill", "mcp", "file"]),
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
    let projectLocation = resolveProjectWorkspaceLocation(
      parsed.data.projectId,
    );
    let gitScope = parsed.data.projectId;
    if (parsed.data.gitWorkspace?.rootId) {
      const project = readWorkspaceProject(parsed.data.projectId);
      const root =
        project &&
        projectWorkspaceRoots(project).find(
          (item) => item.id === parsed.data.gitWorkspace?.rootId,
        );
      if (!root || root.status !== "available")
        throw new AgentRuntimeError(
          "所选仓库不存在或不可用。",
          "GIT_WORKSPACE_ERROR",
          404,
        );
      projectLocation = workspaceRootLocation(root);
      gitScope =
        root.role === "primary"
          ? parsed.data.projectId
          : `${parsed.data.projectId}/${root.id}`;
    }
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
    if (parsed.data.mediaGeneration) {
      if (parsed.data.backendId && parsed.data.backendId !== "native")
        return c.json(
          { error: "Media generation requires the native backend." },
          400,
        );
      const config = getGlobalConfigForRuntime();
      const { providerId, modelId, capability } = parsed.data.mediaGeneration;
      const mediaModel = findMediaModel(config, providerId, modelId);
      if (
        capability &&
        !mediaModel.capabilities.operations.some((operation) =>
          operation.endsWith(
            capability === "image_generation" ? "image" : "video",
          ),
        )
      )
        return c.json(
          { error: "Media model does not support the selected capability." },
          422,
        );
      if (!config.providerConnections[providerId]?.apiKey)
        return c.json(
          { error: "Media provider API key is not configured." },
          422,
        );
    } else if (!parsed.data.backendId || parsed.data.backendId === "native") {
      assertLlmProviderConfigured(parsed.data.projectId);
    }
    let createInput = parsed.data;
    if (parsed.data.gitWorkspace) {
      const selected = await resolveGitWorkspaceSelection(
        projectLocation ??
          resolveRegisteredProjectWorkDir(parsed.data.projectId),
        gitScope,
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
    if (parsed.data.mediaGeneration) {
      agentRuntimeStore.updateSession(session.id, {
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    }
    {
      await runtimeFacade.ensureUiProjection(session.id);
      return c.json(await withAuthoritativeSessionPayload(session.id), 201);
    }
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
    return c.json(
      sessionProcessManager.beginContextCompaction(c.req.param("id")),
      202,
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/search", async (c) => {
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
    {
      const sessions = (await runtimeFacade.listSessionProjection())
        .map((item) => projectSessionState(item as never))
        .filter(
          (session) =>
            session.projectId === projectId &&
            !session.parentSessionId &&
            !session.sessionMetadata?.archivedAt &&
            !session.sessionMetadata?.deletedAt,
        );
      const lowered = q.toLocaleLowerCase();
      const matches = (
        await Promise.all(
          sessions.map(async (session) => {
            if (
              session.title?.toLocaleLowerCase().includes(lowered) ||
              session.prompt.toLocaleLowerCase().includes(lowered)
            )
              return {
                session,
                snippet: (session.title || session.prompt).slice(0, 160),
                updatedAt: session.updatedAt,
              };
            const message = (
              (await runtimeFacade.listMessageHistory(
                session.id,
              )) as AgentRuntimeMessage[]
            ).find((item) =>
              item.content.toLocaleLowerCase().includes(lowered),
            );
            return message
              ? {
                  session,
                  snippet: message.content.slice(0, 160),
                  updatedAt: session.updatedAt,
                }
              : null;
          }),
        )
      )
        .filter(
          (
            item,
          ): item is {
            session: AgentSession;
            snippet: string;
            updatedAt: string;
          } => Boolean(item),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.session.id.localeCompare(b.session.id),
        );
      const page = matches.slice(offset, offset + limit + 1);
      return c.json({
        items: page
          .slice(0, limit)
          .map((item) => ({
            session: projectSessionSummary(item.session),
            snippet: item.snippet,
          })),
        hasMore: page.length > limit,
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions", async (c) => {
  const parsed = listSessionsQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed.error);
  const { limit, offset, status, ...filter } = parsed.data;
  {
    try {
      const all = (await runtimeFacade.listSessionProjection())
        .map((item) => projectSessionState(item as never))
        .filter(
          (session) =>
            !session.sessionMetadata?.archivedAt &&
            !session.sessionMetadata?.deletedAt,
        )
        .filter(
          (session) =>
            !filter.projectId || session.projectId === filter.projectId,
        )
        .filter((session) => !filter.nodeId || session.nodeId === filter.nodeId)
        .filter((session) => !status || session.status === status)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        );
      const countByStatus = Object.fromEntries(
        all.reduce(
          (counts, session) =>
            counts.set(session.status, (counts.get(session.status) ?? 0) + 1),
          new Map<string, number>(),
        ),
      );
      return c.json({
        items: all.slice(offset, offset + limit).map(projectSessionSummary),
        totalCount: all.length,
        countByStatus,
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  }
});
/** Badge counts only need id/status/updatedAt; a dedicated sparse projection
 *  keeps per-project polling payloads at bytes-per-row instead of kilobytes. */
agentRuntimeRoutes.get("/sessions/badges", async (c) => {
  const projectIds = (c.req.query("projectIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (projectIds.length === 0) return c.json({ items: [] });
  try {
    {
      const selected = new Set(projectIds);
      return c.json({
        items: (await runtimeFacade.listSessionProjection())
          .map((item) => projectSessionState(item as never))
          .filter(
            (session) =>
              selected.has(session.projectId) &&
              !session.sessionMetadata?.archivedAt &&
              !session.sessionMetadata?.deletedAt,
          )
          .map((session) => ({
            id: session.id,
            projectId: session.projectId,
            status: session.status,
            updatedAt: session.updatedAt,
          })),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId", async (c) => {
  try {
    return c.json(
      await withAuthoritativeSessionPayload(c.req.param("sessionId")),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
const listArchivesQuerySchema = z.object({
  projectId: z.string().trim().min(1).max(256).optional(),
  q: z.string().trim().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
agentRuntimeRoutes.get("/session-archives", async (c) => {
  const parsed = listArchivesQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const { projectId, q, limit, offset } = parsed.data;
    {
      const query = q?.toLocaleLowerCase();
      const groups = new Map<
        string,
        {
          archiveBatchId: string;
          rootSessionId: string;
          title: string | null;
          prompt: string;
          projectId: string;
          archivedAt: string;
          sessionCount: number;
        }
      >();
      for (const raw of await runtimeFacade.listSessionProjection()) {
        const session = projectSessionState(raw as never) as AgentSession;
        const metadata = session.sessionMetadata ?? {};
        const archivedAt =
          typeof metadata.archivedAt === "string"
            ? metadata.archivedAt
            : undefined;
        const archiveBatchId =
          typeof metadata.archiveBatchId === "string"
            ? metadata.archiveBatchId
            : undefined;
        if (
          !archivedAt ||
          !archiveBatchId ||
          session.sessionMetadata?.deletedAt ||
          (projectId && session.projectId !== projectId)
        )
          continue;
        if (
          query &&
          !session.title?.toLocaleLowerCase().includes(query) &&
          !session.prompt.toLocaleLowerCase().includes(query)
        )
          continue;
        const existing = groups.get(archiveBatchId);
        if (existing) existing.sessionCount += 1;
        else
          groups.set(archiveBatchId, {
            archiveBatchId,
            rootSessionId: archiveBatchId,
            title: session.title,
            prompt: session.prompt,
            projectId: session.projectId,
            archivedAt,
            sessionCount: 1,
          });
      }
      const all = [...groups.values()].sort(
        (a, b) =>
          b.archivedAt.localeCompare(a.archivedAt) ||
          a.rootSessionId.localeCompare(b.rootSessionId),
      );
      const page = all.slice(offset, offset + limit);
      const retentionDays = getGlobalConfig().sessionArchiveRetentionDays;
      const retention = retentionDays === undefined ? 7 : retentionDays;
      return c.json({
        totalCount: all.length,
        items: page.map((item) => ({
          ...item,
          scheduledDeletionAt:
            retention === null
              ? null
              : new Date(
                  Date.parse(item.archivedAt) + retention * 86400000,
                ).toISOString(),
        })),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post("/session-archives/:batchId/restore", async (c) => {
  try {
    {
      const batchId = c.req.param("batchId");
      const projected = (await runtimeFacade.listSessionProjection())
        .map((item) => projectSessionState(item as never) as AgentSession)
        .filter(
          (session) =>
            session.sessionMetadata?.archiveBatchId === batchId &&
            session.sessionMetadata?.archivedAt,
        );
      if (!projected.some((session) => session.id === batchId))
        throw new AgentNotFoundError(batchId);
      await Promise.all(
        projected.map((session) =>
          runtimeFacade.sessionPatch(
            session.id,
            `restore:${batchId}:${session.id}`,
            {
              sessionMetadata: {
                archivedAt: null,
                archiveBatchId: null,
                deletedAt: null,
              },
            },
          ),
        ),
      );
      let restoredSessionIds = projected.map((session) => session.id);
      try {
        restoredSessionIds = agentRuntimeStore.restoreArchivedBatch(batchId);
      } catch (error) {
        logger.warn(
          { batchId, error },
          "[runtime] archived batch compatibility mirror restore failed",
        );
      }
      return c.json({ ok: true, restoredSessionIds });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.delete("/session-archives/:batchId", async (c) => {
  try {
    {
      const batchId = c.req.param("batchId");
      const archived = (await runtimeFacade.listSessionProjection())
        .map((item) => projectSessionState(item as never) as AgentSession)
        .filter(
          (session) =>
            session.sessionMetadata?.archiveBatchId === batchId &&
            session.sessionMetadata?.archivedAt,
        );
      if (!archived.some((session) => session.id === batchId))
        throw new AgentNotFoundError(batchId);
      const deletedAt = new Date().toISOString();
      await Promise.all(
        archived.map((session) =>
          runtimeFacade.sessionPatch(
            session.id,
            `archive-delete:${batchId}:${session.id}`,
            { sessionMetadata: { deletedAt } },
          ),
        ),
      );
      for (const session of archived) invalidateSessionEnvironment(session.id);
      return c.json({
        ok: true,
        deletedSessionIds: archived.map((session) => session.id),
      });
    }
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
    if (!id) throw new AgentValidationError("Session id is required.");
    const parentId = agentRuntimeStore.getSession(id).parentSessionId;
    const control = await readControl(c);
    await runCoordinator.interrupt(
      id,
      "User requested session stop.",
      async () => {
        {
          await Promise.all(
            agentRuntimeStore
              .listSessionTree(id)
              .map((session) =>
                runtimeFacade.stopSessionAuthoritative(
                  session.id,
                  "interrupted",
                  "User requested session stop.",
                ),
              ),
          );
        }
        for (const session of agentRuntimeStore.listSessionTree(id))
          invalidateSessionEnvironment(session.id);
        if (parentId) invalidateSessionEnvironment(parentId);
      },
      control.runId,
    );
    return c.json(
      projectSessionState(
        (await runtimeFacade.uiSnapshotAuthoritative(id)).session,
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
async function archiveSessionRoute(c: Context) {
  try {
    const id = c.req.param("sessionId");
    if (!id) throw new AgentValidationError("Session id is required.");
    const control = await readControl(c);
    const result = await archiveSessionAfterShutdown(id, control.runId);
    {
      await Promise.all(
        result.archivedSessionIds.map((archivedId) =>
          runtimeFacade.sessionPatch(
            archivedId,
            `archive:${result.archiveBatchId}:${archivedId}`,
            {
              sessionMetadata: {
                archivedAt: result.archivedAt,
                archiveBatchId: result.archiveBatchId,
              },
            },
          ),
        ),
      );
    }
    for (const archivedId of result.archivedSessionIds)
      invalidateSessionEnvironment(archivedId);
    if (result.parentId) invalidateSessionEnvironment(result.parentId);
    return c.json({
      ok: true,
      ...result,
      ...(c.req.method === "DELETE"
        ? { deletedSessionIds: result.archivedSessionIds }
        : {}),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
}
agentRuntimeRoutes.post("/sessions/:sessionId/archive", archiveSessionRoute);
// Compatibility: old clients must archive, never physically delete.
agentRuntimeRoutes.delete("/sessions/:sessionId", archiveSessionRoute);
async function archiveInactiveSessionsRoute(c: Context) {
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
    const toArchive = allSessions.filter(
      (s) =>
        !keep.has(s.status) &&
        !s.sessionMetadata?.runtimeControl &&
        !runCoordinator.isActive(s.id),
    );
    const toArchiveIds = new Set(toArchive.map((s) => s.id));
    const roots = toArchive.filter(
      (s) => !s.parentSessionId || !toArchiveIds.has(s.parentSessionId),
    );
    const archivedIds: string[] = [];
    let archivedBatchCount = 0;
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
      const archived = await archiveSessionAfterShutdown(root.id);
      archivedBatchCount += 1;
      archivedIds.push(...archived.archivedSessionIds);
      for (const archivedId of archived.archivedSessionIds)
        invalidateSessionEnvironment(archivedId);
      if (archived.parentId) invalidateSessionEnvironment(archived.parentId);
    }
    return c.json({
      ok: true,
      archivedBatchCount,
      archivedCount: archivedIds.length,
      archivedSessionIds: archivedIds,
    });
  } catch (error) {
    return runtimeError(c, error);
  }
}
agentRuntimeRoutes.post(
  "/sessions/archive-inactive",
  archiveInactiveSessionsRoute,
);
agentRuntimeRoutes.post(
  "/sessions/clear-inactive",
  archiveInactiveSessionsRoute,
);
agentRuntimeRoutes.get("/sessions/:sessionId/history-window", async (c) => {
  try {
    const id = c.req.param("sessionId");
    return c.json(
      await runtimeFacade.historyWindowAuthoritative(id, c.req.query("cursor")),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/history-timeline", async (c) => {
  try {
    const id = c.req.param("sessionId");
    return c.json(
      await runtimeFacade.historyTimelineAuthoritative(
        id,
        Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER),
      ),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
// History windows intentionally omit large JSON fields. Fetch the saved preview
// only when its reply is mounted, without expanding every history page.
agentRuntimeRoutes.get(
  "/sessions/:sessionId/messages/:messageId/visualization",
  async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      {
        const message = (
          await runtimeFacade.listMessageHistory(sessionId)
        ).find(
          (item) =>
            (
              item as {
                id?: unknown;
              }
            ).id === c.req.param("messageId"),
        ) as AgentRuntimeMessage | undefined;
        if (!message) return c.json({ error: "Message not found." }, 404);
        if (message.role !== "assistant" || message.metadata?.partial)
          return c.json({ message: null });
        hydrateCompletedVisualizations([message]);
        if (
          message.metadata.source !== "inline_visualization" &&
          !(
            message.metadata.purpose === "work_result" &&
            Array.isArray(message.metadata.visualizations)
          )
        )
          return c.json({ message: null });
        if (Buffer.byteLength(JSON.stringify(message)) > 8 * 1024 * 1024)
          return c.json(
            { error: "Preview exceeds the response size limit." },
            413,
          );
        return c.json({ message });
      }
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.get("/sessions/:sessionId/messages", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    {
      return c.json({
        items: await runtimeFacade.listMessageHistory(sessionId),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get(
  "/sessions/:sessionId/messages/:messageId/content",
  async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      {
        const cursor = Number(c.req.query("cursor") ?? 0);
        const revision =
          c.req.query("revision") === undefined
            ? undefined
            : Number(c.req.query("revision"));
        return c.json(
          await runtimeFacade.messageContentAuthoritative(
            sessionId,
            c.req.param("messageId"),
            cursor,
            revision,
          ),
        );
      }
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.get("/sessions/:sessionId/runs", async (c) => {
  try {
    {
      const sessionId = c.req.param("sessionId");
      const [history, snapshot] = await Promise.all([
        runtimeFacade.listRunHistory(sessionId),
        runtimeFacade.uiSnapshotAuthoritative(sessionId),
      ]);
      const items = [...history] as Array<{
        id?: string;
      }>;
      if (
        snapshot.run &&
        !items.some(
          (item) =>
            item.id ===
            (
              snapshot.run as {
                id?: string;
              }
            ).id,
        )
      )
        items.unshift(snapshot.run);
      return c.json({ items });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId", async (c) => {
  try {
    {
      const sessionId = c.req.param("sessionId");
      const runId = c.req.param("runId");
      const [runs, snapshot] = await Promise.all([
        runtimeFacade.listRunHistory(sessionId),
        runtimeFacade.uiSnapshotAuthoritative(sessionId),
      ]);
      const run = [...runs, ...(snapshot.run ? [snapshot.run] : [])].find(
        (item) =>
          (
            item as {
              id?: unknown;
            }
          ).id === runId,
      ) as AgentRun | undefined;
      if (!run || run.sessionId !== sessionId)
        return c.json({ error: "Run not found" }, 404);
      return c.json(run);
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId/steps", async (c) => {
  try {
    {
      const items = await runtimeFacade.listHistoryObjects(
        c.req.param("sessionId"),
        "list_steps",
      );
      return c.json({
        items: items.filter(
          (item) =>
            (
              item as {
                runId?: string;
              }
            ).runId === c.req.param("runId"),
        ),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/steps", async (c) => {
  try {
    return c.json({
      items: await runtimeFacade.listHistoryObjects(
        c.req.param("sessionId"),
        "list_steps",
      ),
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
      await runCoordinator.submitAsync(sessionId, input, requestId, mode),
      202,
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/runs/:runId/stream", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    {
      const [snapshot, runs] = await Promise.all([
        runtimeFacade.uiSnapshotAuthoritative(sessionId),
        runtimeFacade.listRunHistory(sessionId),
      ]);
      const found = [...runs, ...(snapshot.run ? [snapshot.run] : [])].some(
        (item) =>
          (
            item as {
              id?: unknown;
              sessionId?: unknown;
            }
          ).id === runId &&
          (
            item as {
              sessionId?: unknown;
            }
          ).sessionId === sessionId,
      );
      if (!found) return c.json({ error: "Run not found" }, 404);
    }
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .safeParse(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0");
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
      session: projectSessionState(
        (await runtimeFacade.uiSnapshotAuthoritative(id)).session,
      ),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post("/sessions/:sessionId/runtime-ticket", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({
      clientId: z.string().min(1).max(128),
      snapshot: z.boolean().default(false),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const sessionId = c.req.param("sessionId");
    if (process.env.SYNAX_DESKTOP_SIDECAR !== "1") {
      return c.json({ transport: "node" as const });
    }
    // The session middleware validated the persisted Rust projection. Issuing
    // a read ticket must never create/seed a session from the SQL mirror.
    c.header("Cache-Control", "no-store");
    const ticket = await runtimeFacade.uiTicket(
      sessionId,
      parsed.data.clientId,
    );
    if (!ticket) throw new Error("Runtime sidecar ticket is unavailable.");
    return c.json({ transport: "rust" as const, ticket });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/snapshot", async (c) => {
  try {
    const snapshot = await runtimeJournal.snapshotDurable(
      c.req.param("sessionId"),
    );
    return c.json({
      ...snapshot,
      liveChunks: snapshot.liveChunks ?? [],
      completedStepIds: snapshot.completedStepIds ?? [],
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/stream", async (c) => {
  const sessionId = c.req.param("sessionId");
  try {
    {
      // Validate against the persisted Rust projection before opening the
      // HTTP observation stream backed by Rust replay.
      await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    }
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
    // Manual compaction has no run/journal chunk, but uses the same UI stream.
    const unsubscribeCompaction = sessionLiveBus.subscribe(
      sessionId,
      (event) => {
        if (
          observer.signal.aborted ||
          ![
            "context_compaction_started",
            "context_compacted",
            "context_compaction_failed",
            "context_compaction_state",
            "media_job",
          ].includes(event.type)
        )
          return;
        void stream
          .writeSSE({ event: event.type, data: JSON.stringify(event) })
          .catch(detach);
      },
    );
    try {
      if (c.req.query("auxiliary") === "1") {
        if (!observer.signal.aborted)
          await new Promise<void>((resolve) =>
            observer.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        return;
      }
      const snapshot = await runtimeJournal.snapshotDurable(sessionId);
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
      unsubscribeCompaction();
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
    const accepted = await runCoordinator.submitAsync(
      id,
      parsed.data,
      c.req.header("Idempotency-Key") ?? randomUUID(),
    );
    return observeRunResponse(c, id, accepted.run.id);
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/events", async (c) => {
  {
    try {
      const sessionId = c.req.param("sessionId");
      const parsed = listEventsQuerySchema.safeParse(
        Object.fromEntries(new URL(c.req.url).searchParams),
      );
      if (!parsed.success) return validationError(c, parsed.error);
      const items = (await runtimeFacade.listHistoryObjects(
        sessionId,
        "list_events",
      )) as RuntimeEvent[];
      const index = parsed.data.after
        ? items.findIndex((item) => item.id === parsed.data.after)
        : -1;
      return c.json({ items: index >= 0 ? items.slice(index + 1) : items });
    } catch (error) {
      return runtimeError(c, error);
    }
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
    const accepted = await runCoordinator.submitAsync(
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
agentRuntimeRoutes.get("/sessions/:sessionId/plan", async (c) => {
  try {
    {
      const plans = await runtimeFacade.listHistoryObjects(
        c.req.param("sessionId"),
        "list_plans",
      );
      return c.json({ plan: plans[0] ?? null });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/plans", async (c) => {
  try {
    return c.json({
      plans: await runtimeFacade.listHistoryObjects(
        c.req.param("sessionId"),
        "list_plans",
      ),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/plans/:revision", async (c) => {
  try {
    {
      const revision = Number(c.req.param("revision"));
      if (!Number.isInteger(revision) || revision < 1)
        return c.json(
          { error: "Plan revision must be a positive integer." },
          400,
        );
      const plan = (
        await runtimeFacade.listHistoryObjects(
          c.req.param("sessionId"),
          "list_plans",
        )
      ).find(
        (item) =>
          (
            item as {
              revision?: unknown;
            }
          ).revision === revision,
      );
      return plan
        ? c.json({ plan })
        : c.json({ error: "Plan revision not found." }, 404);
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post(
  "/sessions/:sessionId/plans/:revision/restore",
  async (c) => {
    try {
      const session = agentSessionRuntime.get(c.req.param("sessionId"));
      const revision = Number(c.req.param("revision"));
      if (!Number.isInteger(revision) || revision < 1)
        return c.json(
          { error: "Plan revision must be a positive integer." },
          400,
        );
      if (
        session.parentSessionId ||
        session.activeRunId ||
        ["running", "waiting_input", "waiting_permission"].includes(
          session.status,
        )
      )
        return c.json(
          { error: "Stop the session before restoring a plan revision." },
          409,
        );
      const plan = restorePlanArtifact(session.id, revision);
      const goalMode = session.sessionMetadata?.mode === "goal";
      const metadataPatch = {
        mode: goalMode ? "goal" : "chat",
        plan: { ...plan, status: "draft" },
        goal: goalMode
          ? { ...initializeGoal(plan.objective), status: "planning" }
          : null,
      };
      const updated = (await runtimeFacade.sessionPatch(
        session.id,
        `plan-restore:${session.id}:${revision}`,
        { sessionMetadata: metadataPatch },
      )) as AgentSession;
      return c.json({ plan, session: updated });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.get("/sessions/:sessionId/artifacts", async (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({
      items: await runtimeFacade.listHistoryObjects(
        c.req.param("sessionId"),
        "list_artifacts",
      ),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/tool-calls", async (c) => {
  try {
    agentSessionRuntime.get(c.req.param("sessionId"));
    return c.json({
      items: (
        await runtimeFacade.listHistoryObjects(
          c.req.param("sessionId"),
          "list_tool_calls",
        )
      ).map((item) => projectToolCallForWire(item as never)),
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
    const sessionId = c.req.param("sessionId");
    {
      const [snapshot, tools, messages, projections, assets] =
        await Promise.all([
          runtimeFacade.uiSnapshotAuthoritative(sessionId),
          runtimeFacade.listHistoryObjects(sessionId, "list_tool_calls"),
          runtimeFacade.listMessageHistory(sessionId),
          runtimeFacade.listSessionProjection(),
          runtimeFacade.listBoundAssets(sessionId),
        ]);
      const session = projectSessionState(
        snapshot.session as never,
      ) as AgentSession;
      const children = projections
        .map((item) => projectSessionState(item as never) as AgentSession)
        .filter(
          (item) =>
            !item.sessionMetadata?.archivedAt &&
            !item.sessionMetadata?.deletedAt,
        )
        .filter(
          (item) =>
            item.parentSessionId === sessionId ||
            session.childSessionIds.includes(item.id),
        );
      return c.json(
        await getSessionEnvironment(sessionId, {
          session,
          toolCalls: tools as ToolCallRecord[],
          messages: messages as AgentRuntimeMessage[],
          children,
          assetNames: new Map(
            (
              assets as Array<{
                id: string;
                filename: string;
              }>
            ).map((asset) => [asset.id, asset.filename]),
          ),
        }),
      );
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get(
  "/sessions/:sessionId/environment/input-source/:toolCallId",
  async (c) => {
    try {
      {
        const sessionId = c.req.param("sessionId");
        const calls = await runtimeFacade.listHistoryObjects(
          sessionId,
          "list_tool_calls",
        );
        const call = (
          calls as Array<{
            id?: unknown;
          }>
        ).find((item) => item.id === c.req.param("toolCallId"));
        if (!call) return c.json({ error: "Input source not found." }, 404);
        return c.json(
          getSessionInputSourceContentFromRecord(call as ToolCallRecord),
        );
      }
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
agentRuntimeRoutes.post(
  "/sessions/:sessionId/environment/file/system-terminal",
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        path: z.string().min(1).max(1024),
        rootId: z.string().min(1).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid file payload" }, 400);
    try {
      await openSessionFileInSystemTerminal(
        c.req.param("sessionId"),
        parsed.data.path,
        parsed.data.rootId,
      );
      return c.json({ ok: true });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.post(
  "/sessions/:sessionId/environment/file/trash",
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        path: z.string().min(1).max(1024),
        rootId: z.string().min(1).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid trash payload" }, 400);
    try {
      return c.json(
        await trashSessionEnvironmentFile(
          c.req.param("sessionId"),
          parsed.data.path,
          parsed.data.rootId,
        ),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.post(
  "/sessions/:sessionId/environment/file/rename",
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        path: z.string().min(1).max(1024),
        newName: z.string().min(1).max(255),
        rootId: z.string().min(1).optional(),
      })
      .safeParse(body);
    if (!parsed.success)
      return c.json({ error: "Invalid rename payload" }, 400);
    try {
      return c.json(
        await renameSessionEnvironmentFile(
          c.req.param("sessionId"),
          parsed.data.path,
          parsed.data.newName,
          parsed.data.rootId,
        ),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
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
  transferChanges: z.boolean().optional(),
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
          parsed.data.transferChanges ?? false,
        ),
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.post(
  "/sessions/:sessionId/git/branches/create",
  async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const parsed = switchBranchSchema.safeParse(body.data);
    if (!parsed.success) return validationError(c, parsed.error);
    try {
      return c.json(
        await createSessionGitBranch(
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
  includeUntracked: z.boolean().optional(),
  model: z.string().trim().min(1).max(256),
  locale: z.enum(["zh", "en"]).optional(),
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
  branchName: z.string().min(1).max(1024).optional(),
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
agentRuntimeRoutes.post("/sessions/:sessionId/git/push", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({ rootId: z.string().min(1).optional() })
    .safeParse(body.data ?? {});
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json(
      await pushSessionWorkspace(c.req.param("sessionId"), parsed.data),
    );
  } catch (error) {
    return runtimeError(c, error);
  }
});
const restoreSessionFileSchema = z.object({
  rootId: z.string().min(1).optional(),
  path: z.string().trim().min(1).max(1024),
});
agentRuntimeRoutes.post("/sessions/:sessionId/git/files/restore", async (c) => {
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
});
agentRuntimeRoutes.get("/sessions/:sessionId/stats", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    {
      const session = projectSessionState(
        (await runtimeFacade.uiSnapshotAuthoritative(sessionId))
          .session as never,
      );
      const configuredContextLimit =
        await resolveSessionConfiguredContextLimit(session);
      return c.json(
        await runtimeFacade.sessionStatsAuthoritative(
          sessionId,
          configuredContextLimit,
        ),
      );
    }
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
agentRuntimeRoutes.get("/sessions/:sessionId/invocation-usage", async (c) => {
  try {
    {
      const sessionId = c.req.param("sessionId");
      const [snapshot, calls] = await Promise.all([
        runtimeFacade.uiSnapshotAuthoritative(sessionId),
        runtimeFacade.listHistoryObjects(sessionId, "list_tool_calls"),
      ]);
      return c.json(
        resolveSessionInvocationUsageFromRecords(
          snapshot.session.projectId,
          calls as ToolCallRecord[],
        ),
      );
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/todos", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    {
      const events = (await runtimeFacade.listHistoryObjects(
        sessionId,
        "list_events",
      )) as Array<{
        type?: string;
        payload?: {
          tasks?: unknown;
        };
      }>;
      const latestTaskEvent = [...events]
        .reverse()
        .find((event) => event.type === "task_state_updated");
      const tasks = Array.isArray(latestTaskEvent?.payload?.tasks)
        ? (latestTaskEvent.payload.tasks as Array<{
            id: string;
            subject: string;
            status: string;
          }>)
        : [];
      return c.json({
        items: tasks
          .filter((task) => task.status !== "deleted")
          .map((task) => ({
            id: task.id,
            label: task.subject,
            status: task.status === "completed" ? "done" : task.status,
          })),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.get("/sessions/:sessionId/permissions", async (c) => {
  try {
    return c.json({ items: await runtimeFacade.listHistoryObjects(c.req.param('sessionId'), 'list_permissions') });
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
    const session = projectSessionState(
      (await runtimeFacade.uiSnapshotAuthoritative(sessionId)).session as never,
    );
    if (session.sessionMetadata?.runtimeControl)
      return c.json(
        { error: "Wait for execution shutdown before changing permissions." },
        409,
      );
    validateBackendTurnInput(resolveSessionBackend(sessionId).id, parsed.data);
    const updated = await applySessionPermissionUpdateAuthoritative(
      sessionId,
      parsed.data,
    );
    return c.json(await withAuthoritativeSessionPayload(updated.id));
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
      const session = projectSessionState(
        (await runtimeFacade.uiSnapshotAuthoritative(sessionId))
          .session as never,
      );
      const previous = (await runtimeFacade.listHistoryObjects(sessionId, 'list_permissions')).find(
        (item) =>
          item &&
          typeof item === "object" &&
          (
            item as {
              id?: unknown;
            }
          ).id === c.req.param("permissionId"),
      ) as PermissionDecision | undefined;
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
      let decision: PermissionDecision;
      {
        const nextState = await runtimeFacade.controlCommand({
          sessionId,
          requestId: `permission-reply:${c.req.param("permissionId")}:${parsed.data.reply}`,
          operation: "permission_reply",
          payload: {
            id: c.req.param("permissionId"),
            reply: parsed.data.reply,
            message: parsed.data.message,
          },
        });
        const updated = (nextState as { entity?: unknown }).entity;
        if (!updated || typeof updated !== "object")
          throw new AgentRuntimeError(
            "Permission response was not persisted.",
            "STORAGE_UNAVAILABLE",
            503,
          );
        decision = updated as PermissionDecision;
      }
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
      const permissionEndedSession =
        !decision.resumeToken && decision.action !== "allow";
      const permissionResolvedAt = new Date().toISOString();
      let authoritativeSession: AgentSession | undefined;
      {
        authoritativeSession = projectSessionState(
          (await runtimeFacade.uiSnapshotAuthoritative(sessionId))
            .session as never,
        );
      }
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
      return c.json(
        authoritativeSession
          ? { decision, session: authoritativeSession }
          : decision,
      );
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.get("/sessions/:sessionId/input-queue", async (c) => {
  try {
    const queue = await inputQueueRuntime.snapshot(c.req.param("sessionId"));
    return c.json({
      items: queue.items,
      forceInjectItemId: queue.forceInjectItemId,
      projectionRevision: queue.revision,
    });
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
    await inputQueueRuntime.enqueue(sessionId, parsed.data);
    await runCoordinator.dispatchQueuedInput(sessionId);
    const queue = await inputQueueRuntime.snapshot(sessionId);
    return c.json({
      items: queue.items,
      forceInjectItemId: queue.forceInjectItemId,
      projectionRevision: queue.revision,
    });
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
        items: await inputQueueRuntime.move(
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
agentRuntimeRoutes.delete(
  "/sessions/:sessionId/input-queue/:itemId",
  async (c) => {
    try {
      return c.json({
        items: await inputQueueRuntime.remove(
          c.req.param("sessionId"),
          c.req.param("itemId"),
        ),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
agentRuntimeRoutes.post(
  "/sessions/:sessionId/input-queue/:itemId/force",
  async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      await runCoordinator.forceQueuedInput(sessionId, c.req.param("itemId"));
      const queue = await inputQueueRuntime.snapshot(sessionId);
      return c.json({
        items: queue.items,
        forceInjectItemId: queue.forceInjectItemId,
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  },
);
// ============================== SSE 事件流 =======================
agentRuntimeRoutes.get("/events/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const lifetime = observationLifetime(c.req.raw.signal, stream);
    const onEvent = (event: {
      type: string;
      sessionId: string;
      patch?: Record<string, unknown>;
    }) => {
      if (lifetime.signal.aborted) return;
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
        .catch(lifetime.stop);
    };
    const unsubscribe = runtimeBus.subscribe(onEvent);
    const heartbeat = setInterval(() => {
      if (!lifetime.signal.aborted)
        void stream
          .writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
          .catch(lifetime.stop);
    }, 25000);
    try {
      if (lifetime.signal.aborted) return;
      await stream.writeSSE({ event: SseEventType.Connected, data: "{}" });
      await lifetime.ended;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      lifetime.dispose();
    }
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
    const onEvent = (event: SessionLiveEvent) => {
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
    }, 25000);
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
agentRuntimeRoutes.get("/sessions/:sessionId/interactions", async (c) => {
  try {
    return c.json({ interactions: await runtimeFacade.listHistoryObjects(c.req.param('sessionId'), 'list_interactions') });
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
      const interaction = await interactionService.replyAuthoritative(
        sessionId,
        id,
        parsed.data,
      );
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
agentRuntimeRoutes.patch("/sessions/:sessionId/pin", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({ pinned: z.boolean() })
    .strict()
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const id = c.req.param("sessionId");
    {
      const patched = (await runtimeFacade.sessionPatch(
        id,
        `session-pin:${id}:${parsed.data.pinned}`,
        { sessionMetadata: { pinned: parsed.data.pinned } },
      )) as AgentSession;
      return c.json({
        session: projectSessionSummary(projectSessionState(patched as never)),
      });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.patch("/sessions/:sessionId/mode", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({ mode: z.enum(["chat", "goal"]) })
    .strict()
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const id = c.req.param("sessionId");
    const session = projectSessionState(
      (await runtimeFacade.uiSnapshotAuthoritative(id)).session as never,
    );
    if (
      session.parentSessionId ||
      !["synax", "goal"].includes(session.profileId)
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
      )
    )
      return c.json(
        {
          error:
            "Stop the run and resolve any input form before switching mode.",
        },
        409,
      );
    const mode = parsed.data.mode;
    {
      const patched = (await runtimeFacade.sessionPatch(
        id,
        `session-mode:${id}:${mode}`,
        {
          sessionMetadata: {
            mode,
            ...(mode === "goal" && !session.sessionMetadata?.goal
              ? { goal: initializeGoal(session.prompt) }
              : {}),
          },
        },
      )) as AgentSession;
      workRuntime.onModeChanged(id, workflowMode(patched));
      return c.json({ session: patched });
    }
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
  message: z.string().trim().min(1).max(100000).optional(),
  includeFiles: z.boolean().default(true),
  workspaceMode: z.enum(["new_worktree", "reuse_worktree"]).optional(),
});
const forkActionSchema = historyActionSchema.extend({
  includeFiles: z.literal(false).default(false),
  workspaceMode: z.enum(["new_worktree", "reuse_worktree"]),
});
agentRuntimeRoutes.get("/sessions/:sessionId/checkpoints", async (c) => {
  try {
    const encoded = c.req.query("messageIds");
    const messageIds =
      encoded === undefined
        ? undefined
        : z
            .array(z.string().min(1).max(256))
            .max(64)
            .parse(JSON.parse(encoded));
    {
      const sessionId = c.req.param("sessionId");
      const [head, checkpoints, messages] = await Promise.all([
        runtimeFacade.historyHeadAuthoritative(sessionId),
        runtimeFacade.listHistoryCheckpoints(sessionId),
        runtimeFacade.listMessageHistory(sessionId) as Promise<
          AgentRuntimeMessage[]
        >,
      ]);
      const messageSet = messageIds ? new Set(messageIds) : undefined;
      const latestMessageId = messages.at(-1)?.id;
      return c.json({
        sessionId,
        revision: head.revision,
        recoveryRequired: false,
        reason: null,
        forkReason: null,
        stopRequired: false,
        rollbackEnabled: checkpoints.length > 0,
        checkpoints: checkpoints
          .filter(
            (checkpoint) =>
              !messageSet ||
              messageSet.has(String(checkpoint.metadata.messageId ?? "")),
          )
          .map((checkpoint) => ({
            id: checkpoint.id,
            kind: checkpoint.metadata.kind === "input" ? "input" : "reply",
            messageId:
              typeof checkpoint.metadata.messageId === "string"
                ? checkpoint.metadata.messageId
                : null,
            stepId:
              typeof checkpoint.metadata.stepId === "string"
                ? checkpoint.metadata.stepId
                : null,
            available: true,
            reason: null,
            transcriptOnly: false,
            destructive: true,
            hasLaterHistory: checkpoint.metadata.messageId !== latestMessageId,
            initialInput:
              checkpoint.metadata.kind === "input" &&
              messages[0]?.id === checkpoint.metadata.messageId,
          })),
      });
    }
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
      workspaceMode: z.enum(["new_worktree", "reuse_worktree"]).optional(),
      includeFiles: z.boolean().default(true),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const sessionId = c.req.param("sessionId");
    {
      if (parsed.data.action === "fork") {
        if (!parsed.data.workspaceMode)
          throw new AgentValidationError(
            "Choose a new worktree or the existing worktree before forking.",
          );
        return c.json({
          ...(await runtimeFacade.previewHistoryAuthoritative(
            sessionId,
            parsed.data.checkpointId,
            false,
          )),
          workspaceMode: parsed.data.workspaceMode,
          warnings: [
            "The fork copies the immutable Rust history head. Workspace files are copied only when a new worktree is selected.",
          ],
        });
      }
      return c.json(
        await runtimeFacade.previewHistoryAuthoritative(
          sessionId,
          parsed.data.checkpointId,
          parsed.data.includeFiles,
        ),
      );
    }
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
      const parsed = (
        action === "fork" ? forkActionSchema : historyActionSchema
      ).safeParse(body.data);
      if (!parsed.success) return validationError(c, parsed.error);
      try {
        const sessionId = c.req.param("sessionId"),
          input = parsed.data;
        {
          if (action === "fork") {
            const source = agentRuntimeStore.getSession(sessionId);
            const sourceBackend = (source.sessionMetadata?.backend ?? {}) as {
              id?: string;
              model?: string;
              workDir?: string;
              workspaceLocation?: unknown;
            };
            let workDir = sourceBackend.workDir;
            let sessionMetadata: Record<string, unknown> = {
              ...(source.sessionMetadata ?? {}),
              forkedFromSessionId: sessionId,
              forkedFromCheckpointId: input.checkpointId,
            };
            if (input.workspaceMode === "new_worktree") {
              const projectLocation = resolveProjectWorkspaceLocation(
                source.projectId,
              );
              const selected = await resolveGitWorkspaceSelection(
                projectLocation ??
                  resolveRegisteredProjectWorkDir(source.projectId),
                source.projectId,
                { kind: "new-worktree" },
              );
              workDir = selected.workDir;
              sessionMetadata = {
                ...sessionMetadata,
                ...(selected.location
                  ? { workspaceLocation: selected.location }
                  : {}),
                gitWorkspace: {
                  kind: selected.kind,
                  branch: selected.branch,
                  path: selected.workDir,
                },
              };
            } else if (!workDir) {
              throw new AgentValidationError(
                "The source session has no reusable workspace.",
              );
            }
            const target = agentSessionRuntime.create({
              projectId: source.projectId,
              nodeId: source.nodeId,
              profileId: source.profileId,
              prompt: source.prompt,
              backendId: sourceBackend.id as CreateSessionRequest["backendId"],
              model: sourceBackend.model,
              workDir,
              thinkingMode: source.thinkingMode,
              reasoningEffort: source.reasoningEffort ?? undefined,
              skillIds: source.skillIds,
              mcpServerIds: source.mcpServerIds,
              sessionMetadata,
            });
            await runtimeFacade.ensureUiProjection(target.id);
            const forked = await runtimeFacade.cloneHistoryAuthoritative({
              sourceSessionId: sessionId,
              targetSessionId: target.id,
              checkpointId: input.checkpointId,
              revision: input.revision,
              requestId: input.requestId,
            });
            const updated = await runtimeFacade.sessionPatch(
              target.id,
              `fork-session:${input.requestId}`,
              {
                status: "completed",
                activeRunId: null,
                completedAt: null,
                resultSummary: null,
                updatedAt: new Date().toISOString(),
                sessionMetadata: {
                  forkedFromSessionId: sessionId,
                  forkedFromCheckpointId: input.checkpointId,
                },
              },
            );
            return c.json(
              {
                sessionId: target.id,
                workspaceMode: input.workspaceMode,
                rollbackEnabled: true,
                revision: forked.revision,
                session: updated,
              },
              201,
            );
          }
          const result = await runtimeFacade.applyHistoryAuthoritative({
            sessionId,
            checkpointId: input.checkpointId,
            revision: input.revision,
            requestId: input.requestId,
            action,
            message: input.message,
          });
          if (result.input && action === "edit") {
            await runCoordinator.submitAsync(
              sessionId,
              result.input,
              authoritativeEditRequestId(sessionId, input.requestId),
              "turn",
            );
          }
          return c.json({
            sessionId: result.sessionId,
            revision: result.revision,
            runId: undefined,
          });
        }
      } catch (error) {
        return runtimeError(c, error);
      }
    },
  );
}
agentRuntimeRoutes.post("/sessions/:sessionId/history/recover", async (c) => {
  try {
    await runtimeFacade.historyCommand({
      sessionId: c.req.param("sessionId"),
      requestId: `history-recover:${randomUUID()}`,
      operation: "reconcile_stream",
      payload: {},
    });
    return c.json({ recovered: true });
  } catch (error) {
    return runtimeError(c, error);
  }
});
agentRuntimeRoutes.post("/sessions/:sessionId/history/visit", async (c) => {
  try {
    {
      await runtimeFacade.historyCommand({
        sessionId: c.req.param("sessionId"),
        requestId: `history-visit:${c.req.param("sessionId")}`,
        operation: "head_read",
        payload: {},
      });
      return c.json({ visited: true });
    }
  } catch (error) {
    return runtimeError(c, error);
  }
});
