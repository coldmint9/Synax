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
  return {
    version: 1,
    id,
    model: normalizeModel(id, model ?? null),
    workDir: workDir ?? null,
  };
}

function normalizeModel(id: BackendId, model: string | null): string | null {
  if (!model) return null;
  return model;
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
  const identities = new Set(
    runs
      .filter((run) => run.model)
      .map(() => "native"),
  );
  if (identities.size > 1)
    throw new AgentValidationError(
      "Legacy backend binding is ambiguous. Keep this history and start a new explicitly bound session.",
    );
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
  const model = normalizeModel(
    binding.id,
    input.model ?? previous ?? binding.model ?? null,
  );
  return model;
}

export function validateBackendTurnInput(
  id: string,
  input: Partial<StreamTurnRequest>,
): void {
  if (id !== "codex") return;
  if (
    input.permissionTier !== undefined ||
    input.permissionOverrides !== undefined
  ) {
    throw new AgentValidationError(
      "Native CLI backends use their own sandbox and approvals, not Synax permission tiers or overrides.",
    );
  }
  if (
    input.maxSteps !== undefined ||
    input.maxTokens !== undefined ||
    input.temperature !== undefined
  ) {
    throw new AgentValidationError(
      "Native CLI backends control their own agent loop; Synax loop limits and temperature are unsupported.",
    );
  }
}
