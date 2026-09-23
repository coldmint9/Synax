import { useEffect, useRef, useState } from "react";
import { agentRuntimeApi, type AgentRuntimeMessage } from "../../../lib/api/agentRuntime";

/** The full text remains available when the window contains a bounded preview. */
export function HistoryTextReaders({
  sessionId,
  revision,
  messages,
  zh,
}: {
  sessionId: string;
  revision: number;
  messages: AgentRuntimeMessage[];
  zh: boolean;
}) {
  const truncated = messages.filter((message) =>
    message.historyProjection?.omittedFields.includes("content"),
  );
  if (!truncated.length) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-[1.2rem] text-xs text-muted-foreground">
      {truncated.map((message) => (
        <HistoryTextReader
          key={message.id}
          sessionId={sessionId}
          messageId={message.id}
          revision={revision}
          zh={zh}
        />
      ))}
    </div>
  );
}

function HistoryTextReader({
  sessionId,
  messageId,
  revision,
  zh,
}: {
  sessionId: string;
  messageId: string;
  revision: number;
  zh: boolean;
}) {
  const generation = useRef(0);
  const [page, setPage] = useState<{ text: string; next?: number }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    generation.current++;
    setPage(undefined);
    setError("");
    return () => {
      generation.current++;
    };
  }, [sessionId, messageId, revision]);
  const read = async (cursor = 0) => {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await agentRuntimeApi.messageContentPage(
        sessionId,
        messageId,
        cursor,
        revision,
      );
      if (token === generation.current) setPage(value);
    } catch (e) {
      if (token === generation.current) setError(String(e));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };
  return (
    <details className="w-full">
      <summary>
        {zh
          ? "长消息全文（分段读取，编辑预览已禁用）"
          : "Long message (paged; preview editing disabled)"}
      </summary>
      <button className="underline" disabled={busy} onClick={() => void read()}>
        {zh ? "读取首段" : "First chunk"}
      </button>
      {page?.next !== undefined && (
        <button
          className="ml-3 underline"
          disabled={busy}
          onClick={() => void read(page.next)}
        >
          {zh ? "下一段" : "Next chunk"}
        </button>
      )}
      {page && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap">
          {page.text}
        </pre>
      )}
      {error && <span className="text-danger">{error}</span>}
    </details>
  );
}
