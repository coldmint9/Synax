import type { RemotePrReference } from "../../../../services/local-node/modules/remote-pr/contracts";
import type { ConversationGitReference as LocalGitReference } from "../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";
import type { AgentRuntimeMessage } from "../../adapters/transport/agentRuntime";

export type ConversationGitReference = LocalGitReference | RemotePrReference;

export type GitMergeReplyPart = {
  type: "git_merge";
  reference: ConversationGitReference;
  messageId: string;
  superseded?: { replacementMessageId: string; supersededAt: string };
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
  if (!["synax.git-merge", "synax.git-pr"].includes(String(reference.schema)) || reference.schemaVersion !== 1 ||
      !identifier(reference.objectId) || !identifier(reference.sessionId) ||
      reference.sessionId !== sessionId || !identifier(reference.projectId) ||
      (reference.rootId !== undefined && !identifier(reference.rootId)) ||
      typeof reference.title !== "string" || !reference.title.trim() ||
      reference.title.length > 250 || /[\u0000-\u001f\u007f]/.test(reference.title)) return null;
  return {
    schema: reference.schema as ConversationGitReference["schema"],
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
  const timeline = message.metadata.gitMergeTimeline as Record<string, unknown> | undefined;
  const superseded = reference.schema === 'synax.git-merge' && timeline?.state === 'superseded' &&
    identifier(timeline.replacementMessageId) && typeof timeline.supersededAt === 'string' &&
    timeline.supersededAt.length <= 64 && Number.isFinite(Date.parse(timeline.supersededAt))
    ? { replacementMessageId: timeline.replacementMessageId, supersededAt: timeline.supersededAt } : undefined;
  return [{ type: "git_merge", reference, messageId: message.id, ...(superseded ? { superseded } : {}) }];
}
