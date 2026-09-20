import { isAcpProviderId } from "../../../lib/config/acp-provider-ids.js";
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
  const slash = model.indexOf("/");
  const prefix = slash < 0 ? model : model.slice(0, slash);
  if (isAcpProviderId(prefix)) {
    if (id !== prefix || slash < 0 || !model.slice(slash + 1)) {
      throw new AgentValidationError(
        "The model belongs to a different execution backend. Start a new session to switch backends.",
      );
    }
    return model.slice(slash + 1);
  }
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
  const acp = session.sessionMetadata?.acp as
    | { providerId?: unknown; engineModel?: unknown }
    | undefined;
  if (
    acp &&
    typeof acp.providerId === "string" &&
    isAcpProviderId(acp.providerId)
  ) {
    return makeBackendBinding(
      acp.providerId,
      typeof acp.engineModel === "string" ? acp.engineModel : null,
    );
  }
  const identities = new Set(
    runs
      .filter((run) => run.model)
      .map((run) => {
        const prefix = run.model!.split("/")[0];
        return isAcpProviderId(prefix) ? prefix : "native";
      }),
  );
  if (identities.size > 1)
    throw new AgentValidationError(
      "Legacy backend binding is ambiguous. Keep this history and start a new explicitly bound session.",
    );
  const previous = runs.find((run) => Boolean(run.model));
  const prefix = previous?.model?.split("/")[0];
  return makeBackendBinding(
    prefix && isAcpProviderId(prefix) ? prefix : "native",
    previous?.model,
  );
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
  return isAcpProviderId(binding.id)
    ? `${binding.id}/${model ?? "default"}`
    : model;
}

export function validateBackendTurnInput(
  id: string,
  input: Partial<StreamTurnRequest>,
): void {
  if (id === "claude-code" && input.reasoningEffort === "none") {
    throw new AgentValidationError(
      "Claude Code does not support the none reasoning effort. Select one of its advertised levels.",
    );
  }
  if (id !== "codex" && id !== "claude-code") return;
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
