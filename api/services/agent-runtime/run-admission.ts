import { applySessionPermissionUpdate } from './session-permissions.js';
import { normalizeInput, hasInput, inputParts } from './content-parts.js';
import { bindAssets } from './media-assets.js';
import { prepareTurnReferences } from './turn-references.js';
import { profileService } from './profile-service.js';
import { createHash } from 'node:crypto';
import { getRawSqlite } from '../../db/index.js';
import type { AgentSessionStreamMode } from '../../lib/ipc/agent-session-protocol.js';
import type { AgentRun, StreamTurnRequest } from './contracts.js';
import { resolveBackendModel, resolveSessionBackend, validateBackendTurnInput } from './backends/backend-binding.js';
import { bindSessionWorkDir, tryResolveSessionWorkspaceLocation } from './tools/workspace.js';
import { interactionService } from './interaction-service.js';
import { agentRuntimeStore } from './session-store.js';
import { AgentRuntimeError, AgentValidationError } from './runtime-errors.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';

export interface AcceptedRuntimeInput {
  version: 1;
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
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
  return value;
}

export function acceptRuntimeRun(
  sessionId: string,
  input: StreamTurnRequest,
  requestId: string,
  mode: AgentSessionStreamMode = 'turn',
): { run: AgentRun; reused: boolean } {
  input = normalizeInput(input);
  if (input.contentParts && !hasInput(input)) throw new AgentValidationError('Input is empty.');
  if (!requestId.trim() || requestId.length > 128) throw new AgentValidationError('A request ID of 1–128 characters is required.');
  if (mode === 'resume') throw new AgentValidationError('Resume the pending interaction instead of submitting a new Run.');
  const inputHash = createHash('sha256').update(JSON.stringify(stable({ input, mode }))).digest('hex');
  const db = getRawSqlite();
  return db.transaction(() => {
    let session = agentRuntimeStore.getSession(sessionId);
    const previous = db.prepare(`SELECT id FROM agent_runtime_runs WHERE session_id = ?
      AND json_extract(metadata_json, '$.runtime.requestId') = ?`).get(sessionId, requestId) as { id: string } | undefined;
    if (previous) {
      const run = agentRuntimeStore.getRun(previous.id);
      const runtime = run.metadata.runtime as AcceptedRuntimeInput;
      if (runtime.inputHash !== inputHash) throw new AgentRuntimeError('This request ID was already used for different input.', 'REQUEST_CONFLICT', 409);
      return { run, reused: true };
    }
    if (profileService.getForSession(session).executionHost === 'embedded') {
      throw new AgentRuntimeError('This session belongs to an embedded job host. Use that job’s controls.', 'EMBEDDED_HOST_REQUIRED', 409);
    }
    const recoveringProject = db.prepare("SELECT id FROM agent_runtime_sessions WHERE project_id=? AND id<>? AND json_extract(session_metadata_json, '$.runtimeControl.state')='unconfirmed' LIMIT 1").get(session.projectId, session.id);
    const globalProcess = db.prepare("SELECT id FROM agent_runtime_processes WHERE session_id IS NULL AND state='unconfirmed' LIMIT 1").get();
    if (recoveringProject || globalProcess) throw new AgentRuntimeError('A previous execution requires recovery before this workspace can accept more work.', 'RECOVERY_REQUIRED', 409);
    if (session.sessionMetadata?.runtimeControl) {
      throw new AgentRuntimeError('Execution shutdown is pending or unconfirmed. Inspect the previous execution before resuming.', 'RECOVERY_REQUIRED', 409);
    }
    let parentId = session.parentSessionId;
    while (parentId) {
      const parent = agentRuntimeStore.getSession(parentId);
      if (parent.sessionMetadata?.runtimeControl) throw new AgentRuntimeError('An ancestor execution is stopping or requires recovery.', 'ANCESTOR_STOPPING', 409);
      parentId = parent.parentSessionId;
    }
    const active = db.prepare(`SELECT id FROM agent_runtime_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1`)
      .get(sessionId) as { id: string } | undefined;
    if (active) throw new AgentRuntimeError('This session already has an active or queued execution.', 'SESSION_BUSY', 409);
    const pending = interactionService.pending(sessionId);
    const defersPlan = pending?.kind === 'plan_approval' && hasInput(input);
    if ((pending && !defersPlan) || session.status === 'waiting_permission') {
      throw new AgentRuntimeError('Resolve the pending interaction before submitting another execution.', 'INTERACTION_PENDING', 409);
    }
    if (mode === 'continue' && session.status === 'completed' && !hasInput(input)) {
      throw new AgentValidationError('Completed sessions require a new message to continue.');
    }
    const binding = resolveSessionBackend(sessionId);
    if (tryResolveSessionWorkspaceLocation(sessionId, session.projectId)?.kind === 'wsl' && binding.id !== 'native') {
      throw new AgentRuntimeError('WSL2 projects currently support only the Synax native backend.', 'WSL_BACKEND_UNSUPPORTED', 409);
    }
    validateBackendTurnInput(binding.id, input);
    bindAssets(sessionId, inputParts(input));
    const model = resolveBackendModel(sessionId, input);
    let workDir: string;
    try { workDir = bindSessionWorkDir(sessionId); }
    catch (error) { throw new AgentValidationError(error instanceof Error ? error.message : 'Invalid execution workspace.'); }
    if (input.permissionTier !== undefined || input.permissionOverrides !== undefined) {
      session = applySessionPermissionUpdate(sessionId, input);
    }
    const runtime: AcceptedRuntimeInput = {
      version: 1, requestId, inputHash, mode, input: { ...input, referenceContext: prepareTurnReferences(sessionId, input.references), ...(model ? { model } : {}) },
      backendId: binding.id, workDir, previousSessionStatus: session.status,
    };
    const run = agentRuntimeStore.appendRun({
      id: makeRuntimeId('run'), sessionId, status: 'queued', startedAt: nowIso(), completedAt: null,
      triggerMessageId: null, currentStep: 0, stopReason: null, model, metadata: { runtime },
    });
    // A fresh user message must still pass through Native's existing plan-save handoff.
    if (!defersPlan) agentRuntimeStore.updateSession(sessionId, { status: 'queued', activeRunId: run.id, updatedAt: nowIso() });
    return { run, reused: false };
  })();
}

export function activateAcceptedRun(sessionId: string, runId: string, triggerMessageId: string, model: string | null): AgentRun {
  return getRawSqlite().transaction(() => {
    const run = agentRuntimeStore.getRun(runId);
    if (run.sessionId !== sessionId) throw new AgentValidationError('The accepted Run belongs to another session.');
    if (run.status !== 'queued') throw new AgentRuntimeError('Only a queued Run can be activated.', 'RUN_ALREADY_STARTED', 409);
    return agentRuntimeStore.updateRun(runId, { status: 'running', triggerMessageId, model, startedAt: nowIso() });
  })();
}
