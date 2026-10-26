import { applySessionPermissionUpdate, applySessionPermissionUpdateAuthoritative } from "./session-permissions.js";
import { normalizeInput, hasInput, inputParts } from "./content-parts.js";
import { bindValidatedAssetsAuthoritative, validateAssets } from "./media-assets.js";
import { prepareTurnReferences } from "./turn-references.js";
import { profileService } from "./profile-service.js";
import { createHash } from "node:crypto";
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
} from "./tools/workspace.js";
import { interactionService } from "./interaction-service.js";
import { agentRuntimeStore } from "./session-store.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { ensureSessionRecovered } from './session-recovery.js';
import { logger } from "../../infrastructure/runtime/logger.js";
import { businessStore } from "../../infrastructure/persistence/business-store.js";
import { withSessionWorkspaceLock } from './session-workspace-lock.js';

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
  workspaceBindingRevision?: number;
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

export function acceptRuntimeRunAuthoritative(
  sessionId: string, input: StreamTurnRequest, requestId: string,
  mode: AgentSessionStreamMode = "turn", queueItem?: import("./input-queue-service.js").QueuedInput,
): Promise<{ run: AgentRun; reused: boolean }> {
  return withSessionWorkspaceLock(sessionId, () => prepareAuthoritativeRuntimeRun(sessionId, input, requestId, mode, queueItem));
}

async function prepareAuthoritativeRuntimeRun(
  sessionId: string,
  input: StreamTurnRequest,
  requestId: string,
  mode: AgentSessionStreamMode = "turn",
  queueItem?: import("./input-queue-service.js").QueuedInput,
): Promise<{ run: AgentRun; reused: boolean }> {


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
  await ensureSessionRecovered(sessionId);
  await agentRuntimeStore.hydrateExecutionSession(sessionId);
  const authoritative = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
  if (authoritative.session?.sessionMetadata?.forkPreparing)
    throw new AgentRuntimeError("The conversation copy is not committed yet. Retry the original fork request.", "FORK_PREPARING", 409);
  const historyHead = await runtimeFacade.historyHeadAuthoritative(sessionId);
  const existingRun = authoritative.run as AgentRun | null | undefined;
  const previous = [existingRun, ...agentRuntimeStore.listRuns(sessionId)].find(
    run => (run?.metadata.runtime as AcceptedRuntimeInput | undefined)?.requestId === requestId,
  );
  if (previous) {
    if ((previous.metadata.runtime as AcceptedRuntimeInput).inputHash !== inputHash)
      throw new AgentRuntimeError("This request ID was already used for different input.", "REQUEST_CONFLICT", 409);
    agentRuntimeStore.acceptRunProjection(previous);
    return { run: previous, reused: true };
  }
  if (existingRun && ["queued", "running", "waiting_permission", "waiting_input"].includes(existingRun.status))
    throw new AgentRuntimeError(
      "This session already has an active or pending execution.",
      "SESSION_BUSY",
      409,
    );

  let preparedSession = agentRuntimeStore.getSession(sessionId);
  const preparedBinding = resolveSessionBackend(sessionId);
  if (profileService.getForSession(preparedSession).executionHost === "embedded")
    throw new AgentRuntimeError(
      "This session belongs to an embedded job host. Use that job’s controls.",
      "EMBEDDED_HOST_REQUIRED",
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
  if (input.references?.some(ref => ref.kind === "subagent")) await businessStore.refresh(["subagent-templates"]);
  const savedSubagents = queueItem?.referenceContext?.subagentProfiles ?? input.referenceContext?.subagentProfiles;
  const preparedReferenceContext = permissionChangeRequested
    ? undefined
    : prepareTurnReferences(sessionId, input.references, preparedWorkDir, savedSubagents);

  if (preparedSession.sessionMetadata?.runtimeControl) {
    // Heal the fence before rejecting: recovery is automatic, so a stale stop
    // must not turn the composer into a retry button the user has to press.
    const { runCoordinator } = await import("./run-coordinator.js");
    await runCoordinator.reconcileFencedSession(sessionId).catch((error) => {
      logger.warn(
        {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Execution recovery retry failed",
      );
    });
    preparedSession = agentRuntimeStore.getSession(sessionId);
  }
  if (preparedSession.sessionMetadata?.runtimeControl)
    throw new AgentRuntimeError(
      "Execution shutdown is pending. This session resumes automatically once the previous run stops.",
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

  await bindValidatedAssetsAuthoritative(sessionId, preparedAssets);
  const workDir = bindSessionWorkDir(sessionId);
  let session = preparedSession;
  if (permissionChangeRequested) session = await applySessionPermissionUpdateAuthoritative(sessionId, input);
  const binding = resolveSessionBackend(sessionId);
  const model = preparedModel;
  const runtime: AcceptedRuntimeInput = {
    version: 1,
    historyRevision: historyHead.revision,
    requestId,
    inputHash,
    mode,
    input: {
      ...input,
      referenceContext:
        preparedReferenceContext && preparedWorkDir === workDir
          ? preparedReferenceContext
          : prepareTurnReferences(sessionId, input.references, workDir, savedSubagents),
      ...(model ? { model } : {}),
    },
    backendId: binding.id,
    workDir,
    workspaceBindingRevision: binding.workspaceBindingRevision ?? 0,
    previousSessionStatus: session.status,
    ...(queueItem ? { queueItem } : {}),
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
    await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
    const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    const reusedRun = snapshot.run?.id === admission.runId
      ? snapshot.run as AgentRun
      : agentRuntimeStore.listRuns(sessionId).find(item => item.id === admission.runId);
    if (!reusedRun) throw new Error("Accepted run receipt has no matching persisted run.");
    agentRuntimeStore.acceptRunProjection(reusedRun);
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
  return agentRuntimeStore.transaction(() => {
    const run = agentRuntimeStore.getRun(runId);
    if (run.sessionId !== sessionId)
      throw new AgentValidationError(
        "The accepted Run belongs to another session.",
      );
    if (run.status !== "running")
      throw new AgentRuntimeError(
        "Rust must activate the admitted Run before executing it.",
        "RUN_ALREADY_STARTED",
        409,
      );
    return agentRuntimeStore.updateRun(runId, {
      status: "running",
      triggerMessageId,
      model,
      startedAt: nowIso(),
    });
  });
}

/** In-process compatibility admission used by worker/unit hosts without Rust. */
export async function acceptRuntimeRun(
  sessionId: string,
  input: StreamTurnRequest,
  requestId: string,
  mode: AgentSessionStreamMode = "turn",
): Promise<{ run: AgentRun; reused: boolean }> {
  input = normalizeInput(input);
  if (input.contentParts && !hasInput(input)) throw new AgentValidationError("Input is empty.");
  if (!requestId.trim() || requestId.length > 128) throw new AgentValidationError("A request ID of 1–128 characters is required.");
  if (mode === "resume") throw new AgentValidationError("Resume the pending interaction instead of submitting a new Run.");
  const inputHash = createHash("sha256").update(JSON.stringify(stable({ input, mode }))).digest("hex");
  const session = agentRuntimeStore.getSession(sessionId);
  const previous = agentRuntimeStore.listRuns(sessionId).find(run => (run.metadata.runtime as AcceptedRuntimeInput | undefined)?.requestId === requestId);
  if (previous) {
    const runtime = previous.metadata.runtime as AcceptedRuntimeInput;
    if (runtime.inputHash !== inputHash) throw new AgentRuntimeError("This request ID was already used for different input.", "REQUEST_CONFLICT", 409);
    return { run: previous, reused: true };
  }
  if (agentRuntimeStore.listRuns(sessionId).some(run => ["queued", "running", "waiting_permission", "waiting_input"].includes(run.status)))
    throw new AgentRuntimeError("This session already has an active or pending execution.", "SESSION_BUSY", 409);
  const binding = resolveSessionBackend(sessionId);
  validateBackendTurnInput(binding.id, input);
  const model = resolveBackendModel(sessionId, input);
  const workDir = bindSessionWorkDir(sessionId);
  const runtime: AcceptedRuntimeInput = {
    version: 1,
    requestId,
    inputHash,
    mode,
    input: { ...input, ...(model ? { model } : {}) },
    backendId: binding.id,
    workDir,
    previousSessionStatus: session.status,
  };
  if (input.permissionTier !== undefined || input.permissionOverrides !== undefined)
    applySessionPermissionUpdate(sessionId, input);
  const run = agentRuntimeStore.appendRun({
    id: makeRuntimeId("run"), sessionId, status: "queued", startedAt: nowIso(), completedAt: null,
    triggerMessageId: null, currentStep: 0, stopReason: null, model: model ?? null, metadata: { runtime },
  });
  agentRuntimeStore.updateSession(sessionId, { status: "queued", activeRunId: run.id, updatedAt: nowIso() });
  return { run, reused: false };
}
