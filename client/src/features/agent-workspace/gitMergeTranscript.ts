import type { ConversationGitReference } from "../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";
import type { AgentRuntimeMessage } from "../../adapters/transport/agentRuntime";

export type { ConversationGitReference };

export type GitMergeReplyPart = {
  type: "git_merge";
  reference: ConversationGitReference;
  messageId: string;
};

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Read only the small native-renderer reference; never infer an action from prose. */
export function readConversationGitReference(
  value: unknown,
  sessionId: string,
): ConversationGitReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (reference.schema !== "synax.git-merge" || reference.schemaVersion !== 1 ||
      !identifier(reference.objectId) || !identifier(reference.sessionId) ||
      reference.sessionId !== sessionId || !identifier(reference.projectId) ||
      (reference.rootId !== undefined && !identifier(reference.rootId)) ||
      typeof reference.title !== "string" || !reference.title.trim() ||
      reference.title.length > 250 || /[\u0000-\u001f\u007f]/.test(reference.title)) return null;
  return {
    schema: "synax.git-merge",
    schemaVersion: 1,
    objectId: reference.objectId,
    sessionId: reference.sessionId,
    projectId: reference.projectId,
    ...(reference.rootId !== undefined ? { rootId: reference.rootId } : {}),
    title: reference.title,
  };
}

/** Only a persisted assistant task anchor may introduce a native Git card.
 * Its content is model context (and may contain internal IDs), not visible prose. */
export function gitMergeReplyParts(message: AgentRuntimeMessage): GitMergeReplyPart[] | null {
  if (message.role !== "assistant" || message.metadata?.source !== "git_merge_task" ||
      message.metadata.partial || message.metadata.type === "thinking" ||
      message.metadata.kind === "thought") return null;
  const reference = readConversationGitReference(message.metadata.gitMergeTask, message.sessionId);
  if (!reference) return null;
  return [{ type: "git_merge", reference, messageId: message.id }];
}
