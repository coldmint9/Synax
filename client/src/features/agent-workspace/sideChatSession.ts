import type {
  AgentSession,
  CreateSessionRequest,
} from "../../adapters/transport/agentRuntime";
import {
  SYNAX_PROFILE_ID,
  readSessionBackendId,
  readSynaxPermissionTier,
} from "./synaxSessionTypes";

/** A side chat is an interactive root session. Its source is only a UI link. */
export function sideChatSessionRequest(
  source: AgentSession,
  title: string,
): CreateSessionRequest {
  const backendId = readSessionBackendId(source);
  const backend = source.sessionMetadata?.backend as
    | { workDir?: string | null; model?: string | null; workspaceLocation?: unknown }
    | undefined;
  return {
    projectId: source.projectId,
    nodeId: source.nodeId,
    profileId: SYNAX_PROFILE_ID,
    backendId,
    model: source.model ?? backend?.model ?? undefined,
    workDir: backend?.workDir ?? undefined,
    prompt: title,
    reasoningEffort: source.reasoningEffort ?? undefined,
    ...(backendId === "native" ? {
      permissionTier: readSynaxPermissionTier(source.sessionMetadata),
      permissionOverrides: source.sessionMetadata?.permissionOverrides as CreateSessionRequest["permissionOverrides"],
      skillIds: source.skillIds,
      mcpServerIds: source.mcpServerIds,
    } : {}),
    sessionMetadata: {
      mode: "chat",
      source: "session-page",
      sideChat: true,
      sideChatSourceSessionId: source.id,
      ...(backend?.workspaceLocation
        ? { workspaceLocation: backend.workspaceLocation }
        : {}),
    },
  };
}
