import type {
  AgentRun,
  AgentSession,
  StreamTurnRequest,
} from "../contracts.js";
import { AgentValidationError } from "../runtime-errors.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  backendBindingSchema,
  type BackendBinding,
  type BackendId,
} from "./backend-contracts.js";

export function makeBackendBinding(
  id: BackendId = "native",
  model?: string | null,
  workDir?: string | null,
): BackendBinding {
  validateBackendTurnInput(id);
  return {
    version: 1,
    id,
    model: model || null,
    workDir: workDir ?? null,
  };
}

export function readBackendBinding(
  session: AgentSession,
  runs: AgentRun[] = [],
): BackendBinding {
  const raw = session.sessionMetadata?.backend;
  if (raw !== undefined) {
    const parsed = backendBindingSchema.safeParse(raw);
    if (!parsed.success)
      throw new AgentValidationError(
        "Unsupported or invalid persisted backend binding.",
      );
    return parsed.data;
  }
  // Keep unbound legacy history from silently acquiring the native engine.
  const legacy = session.sessionMetadata?.acp as { providerId?: string; engineModel?: string } | undefined;
  const external = session.sessionMetadata?.nativeBackend as { id?: string; model?: string } | undefined;
  const legacyModel = legacy?.engineModel ?? runs.find(run => run.model?.split("/")[0].endsWith("-acp"))?.model;
  if (legacy || legacyModel || (external?.id && external.id !== "native")) return {
    version: 1, id: legacy?.providerId || legacyModel?.split("/")[0] || external?.id || "retired",
    model: legacyModel ?? external?.model ?? null, workDir: null,
  };
  const previous = runs.find((run) => Boolean(run.model));
  return makeBackendBinding("native", previous?.model);
}

export function resolveSessionBackend(sessionId: string): BackendBinding {
  const session = agentRuntimeStore.getSession(sessionId);
  const binding = readBackendBinding(
    session,
    session.sessionMetadata?.backend === undefined
      ? agentRuntimeStore.listRuns(sessionId)
      : [],
  );
  if (session.sessionMetadata?.backend === undefined) {
    agentRuntimeStore.updateSessionMetadata(sessionId, { backend: binding });
  }
  return binding;
}

export function resolveBackendModel(
  sessionId: string,
  input: StreamTurnRequest,
): string | null {
  const binding = resolveSessionBackend(sessionId);
  const previous = agentRuntimeStore
    .listRuns(sessionId)
    .find((run) => Boolean(run.model))?.model;
  return input.model ?? previous ?? binding.model ?? null;
}

export function validateBackendTurnInput(
  id: string,
  _input?: Partial<StreamTurnRequest>,
): asserts id is BackendId {
  if (id !== "native")
    throw new AgentValidationError(
      "External CLI and ACP engines have been removed. Start a native Synax session.",
    );
}
