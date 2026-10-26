import {
  agentRuntimeApi,
  type AgentRuntimeMessage,
} from "../../../adapters/transport/agentRuntime";

/**
 * History windows may contain a short content preview to keep the initial
 * response small. Replace that preview with the saved message body before it
 * enters the transcript cache.
 */
export async function hydrateHistoryMessageContent(
  sessionId: string,
  messages: readonly AgentRuntimeMessage[],
  revision: number,
  cachedMessages: readonly AgentRuntimeMessage[] = [],
): Promise<AgentRuntimeMessage[]> {
  const cachedById = new Map(cachedMessages.map((message) => [message.id, message]));
  const targets = messages.filter((message) =>
    message.historyProjection?.omittedFields.includes("content") &&
    (!cachedById.has(message.id) ||
      cachedById.get(message.id)?.historyProjection?.omittedFields.includes("content")),
  );
  if (targets.length === 0) {
    return messages.map((message) => {
      const cached = cachedById.get(message.id);
      if (!cached || !message.historyProjection?.omittedFields.includes("content"))
        return message;
      return {
        ...message,
        content: cached.content,
        historyProjection: {
          omittedFields: message.historyProjection.omittedFields.filter(
            (field) => field !== "content",
          ),
        },
      };
    });
  }

  const hydrated = await Promise.all(
    targets.map(async (message) => {
      let cursor = 0;
      let content = "";
      do {
        const page = await agentRuntimeApi.messageContentPage(
          sessionId,
          message.id,
          cursor,
          revision,
        );
        if (page.revision !== revision) {
          throw Object.assign(new Error("History changed while loading message content."), {
            code: "HISTORY_STALE",
          });
        }
        if (page.next != null && (!Number.isSafeInteger(page.next) || page.next <= cursor)) {
          throw new Error("History content cursor did not advance.");
        }
        content += page.text;
        cursor = page.next ?? -1;
      } while (cursor >= 0);

      return {
        ...message,
        content,
        historyProjection: {
          omittedFields: message.historyProjection!.omittedFields.filter(
            (field) => field !== "content",
          ),
        },
      };
    }),
  );

  const byId = new Map<string, AgentRuntimeMessage>();
  for (const message of messages) {
    const cached = cachedById.get(message.id);
    if (!cached || !message.historyProjection?.omittedFields.includes("content"))
      continue;
    byId.set(message.id, {
      ...message,
      content: cached.content,
      historyProjection: {
        omittedFields: message.historyProjection.omittedFields.filter(
          (field) => field !== "content",
        ),
      },
    });
  }
  for (const message of hydrated) byId.set(message.id, message);
  return messages.map((message) => byId.get(message.id) ?? message);
}
