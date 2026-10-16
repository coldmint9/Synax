import { prepareFlatHistory } from "./flat-history-migration.js";
import { versionRuntimeMode } from "./checkpoints/version-runtime/bridge.js";
import {
  assertHistoryUnlocked,
  historyRevision,
} from "./checkpoints/guards.js";
import { applySessionPermissionUpdate } from "./session-permissions.js";
import { normalizeInput, hasInput, inputParts } from "./content-parts.js";
import { bindValidatedAssets, validateAssets } from "./media-assets.js";
import { prepareTurnReferences } from "./turn-references.js";
import { profileService } from "./profile-service.js";
import { createHash } from "node:crypto";
import { getRawSqlite } from "../../infrastructure/database/index.js";
import type { AgentSessionStreamMode } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import type { AgentRun, StreamTurnRequest } from "./contracts.js";
import {
  resolveBackendModel,
  resolveSessionBackend,
  validateBackendTurnInput,
} from "./backends/backend-binding.js";
import {
  bindSessionWorkDir,
  resolveSessionWorkDir,
  tryResolveSessionWorkspaceLocation,
} from "./tools/workspace.js";
import { interactionService } from "./interaction-service.js";
import { agentRuntimeStore } from "./session-store.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

export interface AcceptedRuntimeInput {
  version: 1;
  queueItem?: import("./input-queue-service.js").QueuedInput;
  historyRevision?: number;
  requestId: string;
  inputHash: string;
  mode: AgentSessionStreamMode;
  input: StreamTurnRequest;
  backendId: string;
  workDir: string;
  previousSessionStatus: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

export function acceptRuntimeRun(
  sessionId: string,
  input: StreamTurnRequest,
  requestId: string,
  mode: AgentSessionStreamMode = "turn",
): { run: AgentRun; reused: boolean } {
  prepareFlatHistory(sessionId);
  if (versionRuntimeMode(sessionId) === "transcript")
    throw new AgentRuntimeError(
      "Version transcript rollout is not yet ready for execution.",
      "VERSION_RUNTIME_NOT_READY",
      409,
    );
  input = normalizeInput(input);
  if (input.contentParts && !hasInput(input))
    throw new AgentValidationError("Input is empty.");
  if (!requestId.trim() || requestId.length > 128)
    throw new AgentValidationError(
      "A request ID of 1–128 characters is required.",
    );
  if (mode === "resume")
    throw new AgentValidationError(
      "Resume the pending interaction instead of submitting a new Run.",
    );
  const inputHash = createHash("sha256")
    .update(JSON.stringify(stable({ input, mode })))
    .digest("hex");

  // Resolve filesystem references and validate media before opening the write
  // transaction. These checks can touch the filesystem and provider catalogs;
  // they do not need to hold SQLite's writer reservation. The transaction
  // below only rechecks state and persists the run-level changes.
  const preparedSession = agentRuntimeStore.getSession(sessionId);
  const preparedBinding = resolveSessionBackend(sessionId);
  if (profileService.getForSession(preparedSession).executionHost === "embedded") {
    throw new AgentRuntimeError(
      "This session belongs to an embedded job host. Use that job’s controls.",
      "EMBEDDED_HOST_REQUIRED",
      409,
    );
  }
  if (
    tryResolveSessionWorkspaceLocation(sessionId, preparedSession.projectId)?.kind ===
      "wsl" &&
    preparedBinding.id !== "native"
  ) {
    throw new AgentRuntimeError(
      "WSL2 projects currently support only the Synax native backend.",
      "WSL_BACKEND_UNSUPPORTED",
      409,
    );
  }
  validateBackendTurnInput(preparedBinding.id, input);
  const preparedModel = resolveBackendModel(sessionId, input);
  const preparedAssets = validateAssets(
    inputParts(input),
    preparedSession.projectId,
  );
  let preparedWorkDir: string;
  try {
    preparedWorkDir = resolveSessionWorkDir(
      sessionId,
      preparedSession.projectId,
    );
  } catch (error) {
    throw new AgentValidationError(
      error instanceof Error ? error.message : "Invalid execution workspace.",
    );
  }
  // A permission change is part of the acceptance transaction. Keep
  // reference validation inside that transaction in this uncommon case so a
  // newly granted tier is applied before the files are checked.
  const permissionChangeRequested =
    input.permissionTier !== undefined || input.permissionOverrides !== undefined;
  const preparedReferenceContext = permissionChangeRequested
    ? undefined
    : prepareTurnReferences(sessionId, input.references, preparedWorkDir);

  const db = getRawSqlite();
  return db.transaction(() => {
    assertHistoryUnlocked(sessionId);
    let session = agentRuntimeStore.getSession(sessionId);
    const previous = db
      .prepare(
        `SELECT id FROM agent_runtime_runs WHERE session_id = ?
      AND json_extract(metadata_json, '$.runtime.requestId') = ?`,
      )
      .get(sessionId, requestId) as { id: string } | undefined;
    if (previous) {
      const run = agentRuntimeStore.getRun(previous.id);
      const runtime = run.metadata.runtime as AcceptedRuntimeInput;
      if (runtime.inputHash !== inputHash)
        throw new AgentRuntimeError(
          "This request ID was already used for different input.",
          "REQUEST_CONFLICT",
          409,
        );
      return { run, reused: true };
    }
    if (
      (
        session.sessionMetadata?.contextCompaction as
          | { status?: string }
          | undefined
      )?.status === "running"
    )
      throw new AgentRuntimeError(
        "Wait for context compaction to finish.",
        "COMPACTION_BUSY",
        409,
      );
    if (profileService.getForSession(session).executionHost === "embedded") {
      throw new AgentRuntimeError(
        "This session belongs to an embedded job host. Use that job’s controls.",
        "EMBEDDED_HOST_REQUIRED",
        409,
      );
    }
    // An unconfirmed process belongs to its original execution. Keep that
    // session fenced, but never lock every other session in the project.
    if (session.sessionMetadata?.runtimeControl) {
      throw new AgentRuntimeError(
        "Execution shutdown is pending or unconfirmed. Retry stopping recorded processes in this session.",
        "RECOVERY_REQUIRED",
        409,
      );
    }
    let parentId = session.parentSessionId;
    while (parentId) {
      const parent = agentRuntimeStore.getSession(parentId);
      if (parent.sessionMetadata?.runtimeControl)
        throw new AgentRuntimeError(
          "An ancestor execution is stopping or requires recovery.",
          "ANCESTOR_STOPPING",
          409,
        );
      parentId = parent.parentSessionId;
    }
    const active = db
      .prepare(
        `SELECT id FROM agent_runtime_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1`,
      )
      .get(sessionId) as { id: string } | undefined;
    if (active)
      throw new AgentRuntimeError(
        "This session already has an active or queued execution.",
        "SESSION_BUSY",
        409,
      );
    const pending = interactionService.pending(sessionId);
    const defersPlan = pending?.kind === "plan_approval" && hasInput(input);
    if ((pending && !defersPlan) || session.status === "waiting_permission") {
      throw new AgentRuntimeError(
        "Resolve the pending interaction before submitting another execution.",
        "INTERACTION_PENDING",
        409,
      );
    }
    if (
      mode === "continue" &&
      session.status === "completed" &&
      !hasInput(input)
    ) {
      throw new AgentValidationError(
        "Completed sessions require a new message to continue.",
      );
    }
    const binding = resolveSessionBackend(sessionId);
    if (
      tryResolveSessionWorkspaceLocation(sessionId, session.projectId)?.kind ===
        "wsl" &&
      binding.id !== "native"
    ) {
      throw new AgentRuntimeError(
        "WSL2 projects currently support only the Synax native backend.",
        "WSL_BACKEND_UNSUPPORTED",
        409,
      );
    }
    bindValidatedAssets(sessionId, preparedAssets);
    const model = preparedModel;
    const workDir = bindSessionWorkDir(sessionId);
    if (
      input.permissionTier !== undefined ||
      input.permissionOverrides !== undefined
    ) {
      session = applySessionPermissionUpdate(sessionId, input);
    }
    const runtime: AcceptedRuntimeInput = {
      version: 1,
      historyRevision: historyRevision(sessionId),
      requestId,
      inputHash,
      mode,
      input: {
        ...input,
        referenceContext:
          preparedReferenceContext && preparedWorkDir === workDir
            ? preparedReferenceContext
            : prepareTurnReferences(sessionId, input.references, workDir),
        ...(model ? { model } : {}),
      },
      backendId: binding.id,
      workDir,
      previousSessionStatus: session.status,
    };
    const run = agentRuntimeStore.appendRun({
      id: makeRuntimeId("run"),
      sessionId,
      status: "queued",
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 0,
      stopReason: null,
      model,
      metadata: { runtime },
    });
    // A fresh user message must still pass through Native's existing plan-save handoff.
    if (!defersPlan)
      agentRuntimeStore.updateSession(sessionId, {
        status: "queued",
        activeRunId: run.id,
        updatedAt: nowIso(),
      });
    return { run, reused: false };
  })();
}

/**
 * Authoritative admission path. Rust owns the admission fence and durable
 * queued run document first; SQLite is updated afterwards only as a temporary
 * compatibility mirror for the synchronous execution code that is still being
 * removed.
 */
export async function acceptRuntimeRunAuthoritative(
  sessionId: string,
  input: StreamTurnRequest,
  requestId: string,
  mode: AgentSessionStreamMode = "turn",
): Promise<{ run: AgentRun; reused: boolean }> {
  if (runtimeFacade.streamMode() !== "authoritative")
    return acceptRuntimeRun(sessionId, input, requestId, mode);

  prepareFlatHistory(sessionId);
  if (versionRuntimeMode(sessionId) === "transcript")
    throw new AgentRuntimeError(
      "Version transcript rollout is not yet ready for execution.",
      "VERSION_RUNTIME_NOT_READY",
      409,
    );
  input = normalizeInput(input);
  if (input.contentParts && !hasInput(input))
    throw new AgentValidationError("Input is empty.");
  if (!requestId.trim() || requestId.length > 128)
    throw new AgentValidationError("A request ID of 1–128 characters is required.");
  if (mode === "resume")
    throw new AgentValidationError(
      "Resume the pending interaction instead of submitting a new Run.",
    );

  const inputHash = createHash("sha256")
    .update(JSON.stringify(stable({ input, mode })))
    .digest("hex");
  await runtimeFacade.ensureUiProjection(sessionId);
  const authoritative = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
  const existingRun = authoritative.run as AgentRun | null | undefined;
  if (existingRun && ["queued", "running", "waiting_permission", "waiting_input"].includes(existingRun.status))
    throw new AgentRuntimeError(
      "This session already has an active or pending execution.",
      "SESSION_BUSY",
      409,
    );

  const preparedSession = agentRuntimeStore.getSession(sessionId);
  const preparedBinding = resolveSessionBackend(sessionId);
  if (profileService.getForSession(preparedSession).executionHost === "embedded")
    throw new AgentRuntimeError(
      "This session belongs to an embedded job host. Use that job’s controls.",
      "EMBEDDED_HOST_REQUIRED",
      409,
    );
  if (
    tryResolveSessionWorkspaceLocation(sessionId, preparedSession.projectId)?.kind ===
      "wsl" &&
    preparedBinding.id !== "native"
  )
    throw new AgentRuntimeError(
      "WSL2 projects currently support only the Synax native backend.",
      "WSL_BACKEND_UNSUPPORTED",
      409,
    );
  validateBackendTurnInput(preparedBinding.id, input);
  const preparedModel = resolveBackendModel(sessionId, input);
  const preparedAssets = validateAssets(inputParts(input), preparedSession.projectId);
  let preparedWorkDir: string;
  try {
    preparedWorkDir = resolveSessionWorkDir(sessionId, preparedSession.projectId);
  } catch (error) {
    throw new AgentValidationError(
      error instanceof Error ? error.message : "Invalid execution workspace.",
    );
  }
  const permissionChangeRequested =
    input.permissionTier !== undefined || input.permissionOverrides !== undefined;
  const preparedReferenceContext = permissionChangeRequested
    ? undefined
    : prepareTurnReferences(sessionId, input.references, preparedWorkDir);

  const db = getRawSqlite();
  const previous = db
    .prepare(
      `SELECT id FROM agent_runtime_runs WHERE session_id = ?
       AND json_extract(metadata_json, '$.runtime.requestId') = ?`,
    )
    .get(sessionId, requestId) as { id: string } | undefined;
  if (previous) {
    const run = agentRuntimeStore.listRuns(sessionId).find(item => item.id === previous.id);
    if (run) {
      const runtime = run.metadata.runtime as AcceptedRuntimeInput;
      if (runtime.inputHash !== inputHash)
        throw new AgentRuntimeError(
          "This request ID was already used for different input.",
          "REQUEST_CONFLICT",
          409,
        );
      return { run, reused: true };
    }
    if (existingRun?.id === previous.id) return { run: existingRun, reused: true };
  }
  if (preparedSession.sessionMetadata?.runtimeControl)
    throw new AgentRuntimeError(
      "Execution shutdown is pending or unconfirmed. Retry stopping recorded processes in this session.",
      "RECOVERY_REQUIRED",
      409,
    );
  let parentId = preparedSession.parentSessionId;
  while (parentId) {
    const parent = agentRuntimeStore.getSession(parentId);
    if (parent.sessionMetadata?.runtimeControl)
      throw new AgentRuntimeError(
        "An ancestor execution is stopping or requires recovery.",
        "ANCESTOR_STOPPING",
        409,
      );
    parentId = parent.parentSessionId;
  }
  if (
    (preparedSession.sessionMetadata?.contextCompaction as { status?: string } | undefined)?.status ===
    "running"
  )
    throw new AgentRuntimeError("Wait for context compaction to finish.", "COMPACTION_BUSY", 409);
  const pending = interactionService.pending(sessionId);
  const defersPlan = pending?.kind === "plan_approval" && hasInput(input);
  if ((pending && !defersPlan) || preparedSession.status === "waiting_permission")
    throw new AgentRuntimeError(
      "Resolve the pending interaction before submitting another execution.",
      "INTERACTION_PENDING",
      409,
    );
  if (mode === "continue" && preparedSession.status === "completed" && !hasInput(input))
    throw new AgentValidationError("Completed sessions require a new message to continue.");

  bindValidatedAssets(sessionId, preparedAssets);
  const workDir = bindSessionWorkDir(sessionId);
  let session = preparedSession;
  if (permissionChangeRequested) session = applySessionPermissionUpdate(sessionId, input);
  const binding = resolveSessionBackend(sessionId);
  const model = preparedModel;
  const runtime: AcceptedRuntimeInput = {
    version: 1,
    historyRevision: historyRevision(sessionId),
    requestId,
    inputHash,
    mode,
    input: {
      ...input,
      referenceContext:
        preparedReferenceContext && preparedWorkDir === workDir
          ? preparedReferenceContext
          : prepareTurnReferences(sessionId, input.references, workDir),
      ...(model ? { model } : {}),
    },
    backendId: binding.id,
    workDir,
    previousSessionStatus: session.status,
  };
  const run: AgentRun = {
    id: makeRuntimeId("run"),
    sessionId,
    status: "queued",
    startedAt: nowIso(),
    completedAt: null,
    triggerMessageId: null,
    currentStep: 0,
    stopReason: null,
    model,
    metadata: { runtime },
  };

  const admission = await runtimeFacade.admitExecution(
    { sessionId, run, runtime },
    false,
  );
  if (admission.reused) {
    const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    const reusedRun = snapshot.run?.id === run.id ? (snapshot.run as AgentRun) : run;
    return { run: reusedRun, reused: true };
  }

  // Compatibility mirror only. The durable fence and queued document already
  // exist in Rust, so a mirror failure cannot make a second Rust admission.
  if (!agentRuntimeStore.listRuns(sessionId).some(item => item.id === run.id)) agentRuntimeStore.appendRun(run);
  if (!defersPlan)
    agentRuntimeStore.updateSession(sessionId, {
      status: "queued",
      activeRunId: run.id,
      updatedAt: nowIso(),
    });
  return { run, reused: false };
}

/** Persist this identity on the input itself before any message event can be observed. */
export function acceptedInputRequestId(
  sessionId: string,
  runId?: string,
): string | undefined {
  if (!runId) return undefined;
  const run = agentRuntimeStore.getRun(runId);
  if (run.sessionId !== sessionId)
    throw new AgentValidationError(
      "The accepted Run belongs to another session.",
    );
  return (run.metadata.runtime as AcceptedRuntimeInput | undefined)?.requestId;
}

export function activateAcceptedRun(
  sessionId: string,
  runId: string,
  triggerMessageId: string,
  model: string | null,
): AgentRun {
  return getRawSqlite().transaction(() => {
    const run = agentRuntimeStore.getRun(runId);
    if (run.sessionId !== sessionId)
      throw new AgentValidationError(
        "The accepted Run belongs to another session.",
      );
    if (run.status !== "queued")
      throw new AgentRuntimeError(
        "Only a queued Run can be activated.",
        "RUN_ALREADY_STARTED",
        409,
      );
    return agentRuntimeStore.updateRun(runId, {
      status: "running",
      triggerMessageId,
      model,
      startedAt: nowIso(),
    });
  })();
}
