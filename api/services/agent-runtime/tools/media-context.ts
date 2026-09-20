import type { ToolExecutionInput } from "../contracts.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { getAsset, readAsset, sessionHasAsset } from "../media-assets.js";
import { resolveGatewaySelection } from "../../llm-runtime/gateway.js";
import { resolveBackendModel } from "../backends/backend-binding.js";
import {
  getGlobalConfigForRuntime,
  getProjectConfigForRuntime,
} from "../../../lib/config/config-store.js";
import {
  mergeProviderConfig,
  resolveRuntimeProvider,
} from "../../llm-runtime/resolver.js";
import { getRuntimeCatalog } from "../../llm-runtime/catalog.js";
import { MAX_INPUT_BYTES } from "../content-parts.js";

export function assertSessionMediaBudget(sessionId: string, ids: string[]) {
  const session = store.getSession(sessionId);
  let total = 0;
  for (const id of ids) {
    if (!sessionHasAsset(sessionId, id))
      throw new Error("Media is not attached to this session.");
    total += getAsset(id, session.projectId).size;
  }
  if (total > MAX_INPUT_BYTES)
    throw new Error("Media references exceed the 100 MiB request limit.");
}

export async function resolveSessionMediaProvider(
  input: ToolExecutionInput,
  providerId?: string,
) {
  const session = store.getSession(input.sessionId);
  if (!providerId)
    return resolveGatewaySelection({
      projectId: session.projectId,
      purpose: "agent",
      model:
        (input.runId ? store.getRun(input.runId).model : undefined) ??
        resolveBackendModel(input.sessionId, {}) ??
        undefined,
    });
  const globalConfig = getGlobalConfigForRuntime();
  const projectConfig = getProjectConfigForRuntime(session.projectId);
  if (
    !globalConfig.providers.some(
      (provider) => provider.id === providerId && provider.kind === "api",
    )
  )
    throw new Error(`Media provider '${providerId}' is not configured.`);
  const provider = resolveRuntimeProvider(providerId, {
    catalog: await getRuntimeCatalog(),
    globalConfig,
    projectConfig,
    purpose: "media",
  });
  if (!provider) throw new Error(`Unknown media provider '${providerId}'.`);
  const config = mergeProviderConfig(
    providerId,
    globalConfig.providerConnections[providerId],
    projectConfig?.providerConnection?.providerId === providerId
      ? projectConfig.providerConnection
      : undefined,
  );
  return { provider, config };
}

export async function loadSessionMedia(sessionId: string, id: string) {
  if (!sessionHasAsset(sessionId, id))
    throw new Error("Media is not attached to this session.");
  const session = store.getSession(sessionId);
  const asset = getAsset(id, session.projectId);
  return { asset, bytes: await readAsset(id, session.projectId) };
}
