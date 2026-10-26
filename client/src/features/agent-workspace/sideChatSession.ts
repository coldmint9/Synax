import type {
  AgentSession,
  CreateSessionRequest,
} from "../../adapters/transport/agentRuntime";
import {
  SYNAX_PROFILE_ID,
  isUnsupportedSessionBackend,
  readSynaxPermissionTier,
} from "./synaxSessionTypes";

/** A side chat is an interactive root session. Its source is only a UI link. */
export function sideChatSessionRequest(
  source: AgentSession,
  title: string,
): CreateSessionRequest {
  if (isUnsupportedSessionBackend(source))
    throw new Error("This execution engine has been removed. Start a new Synax session.");
  const backend = source.sessionMetadata?.backend as
    | { workDir?: string | null; model?: string | null; workspaceLocation?: unknown }
    | undefined;
  return {
    projectId: source.projectId,
    nodeId: source.nodeId,
    profileId: SYNAX_PROFILE_ID,
    backendId: "native",
    model: source.model ?? backend?.model ?? undefined,
    workDir: backend?.workDir ?? undefined,
    prompt: title,
    reasoningEffort: source.reasoningEffort ?? undefined,
    permissionTier: readSynaxPermissionTier(source.sessionMetadata),
    permissionOverrides: source.sessionMetadata?.permissionOverrides as CreateSessionRequest["permissionOverrides"],
    skillIds: source.skillIds,
    mcpServerIds: source.mcpServerIds,
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
