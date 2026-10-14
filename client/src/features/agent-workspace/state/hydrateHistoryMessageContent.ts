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

  const byId = new Map(
    messages
      .map((message) => {
        const cached = cachedById.get(message.id);
        if (!cached || !message.historyProjection?.omittedFields.includes("content"))
          return null;
        return [message.id, {
          ...message,
          content: cached.content,
          historyProjection: {
            omittedFields: message.historyProjection.omittedFields.filter(
              (field) => field !== "content",
            ),
          },
        }] as const;
      })
      .filter((entry): entry is readonly [string, AgentRuntimeMessage] => entry !== null),
  );
  for (const message of hydrated) byId.set(message.id, message);
  return messages.map((message) => byId.get(message.id) ?? message);
}
