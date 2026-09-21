import type { ArtifactReference } from "../../../../../api/services/agent-runtime/artifacts/contracts";
import type { AgentRuntimeMessage } from "../../../lib/api/agentRuntime";
/** Executable content is only referenced by server-published metadata, never raw Markdown. */
export function messageArtifacts(
  message: AgentRuntimeMessage,
): ArtifactReference[] {
  if (
    message.role !== "assistant" ||
    message.metadata?.source !== "artifact_publisher" ||
    !Array.isArray(message.metadata.artifacts)
  )
    return [];
  return message.metadata.artifacts.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (
      item.type !== "artifact" ||
      typeof item.artifactId !== "string" ||
      typeof item.revisionId !== "string" ||
      typeof item.title !== "string" ||
      !["inline", "wide"].includes(String(item.presentation))
    )
      return [];
    return [item as unknown as ArtifactReference];
  });
}

export function messageArtifactRequest(message: AgentRuntimeMessage) {
  if (
    message.role !== "assistant" ||
    message.metadata?.source !== "artifact_request"
  )
    return null;
  const value = message.metadata.artifactRequest as
    | Record<string, unknown>
    | undefined;
  return value &&
    typeof value.requestId === "string" &&
    typeof value.title === "string" &&
    typeof value.sourcePath === "string"
    ? {
        requestId: value.requestId,
        title: value.title,
        sourcePath: value.sourcePath,
      }
    : null;
}
