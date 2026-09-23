import { useEffect, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";

export function HistoryWindowControls({ session }: { session?: AgentSession }) {
  const { locale } = useLocale(),
    zh = locale === "zh";
  const page = useAgentSessionStore((s) =>
    session ? s.sessionDetailCache[session.id]?.historyWindow : undefined,
  );
  const messages = useAgentSessionStore((s) =>
    s.selectedSessionId === session?.id ? s.messages : undefined,
  );
  const loading = useAgentSessionStore((s) => s.detailLoading);
  const navigate = useAgentSessionStore((s) => s.navigateHistory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!session) return null;
  const versioned = session.sessionMetadata?.historyStorage === 3;
  const backend = session.sessionMetadata?.backend as
    | { id?: string }
    | undefined;
  const upgradeable =
    !versioned &&
    !session.parentSessionId &&
    !session.childSessionIds.length &&
    (!backend?.id || backend.id === "native") &&
    ["completed", "interrupted", "failed", "cancelled"].includes(
      session.status,
    );
  const upgrade = async () => {
    if (
      !window.confirm(
        zh
          ? "升级会保留当前会话内容，但旧回滚点将不再可用；新的回滚点从升级后开始。升级期间不可运行或编辑会话。是否继续？"
          : "Keep the current conversation, but retire legacy rollback points. New checkpoints start after upgrade. Continue?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await agentRuntimeApi.upgradeHistory(session.id);
      const state = useAgentSessionStore.getState();
      await state.refreshSessions();
      if (useAgentSessionStore.getState().selectedSessionId === session.id)
        await state.refreshDetail();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!page && !upgradeable) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
      role="status"
    >
      {page && (
        <>
          <span>
            {zh ? "分窗读取历史，不累积加载" : "Bounded history window"}
          </span>
          {page.olderCursor && (
            <button
              className="underline"
              disabled={loading}
              onClick={() => void navigate(page.olderCursor)}
            >
              {zh ? "更早记录" : "Older"}
            </button>
          )}
          {!page.latest && (
            <button
              className="underline"
              disabled={loading}
              onClick={() => void navigate()}
            >
              {zh ? "回到最新" : "Latest"}
            </button>
          )}
          {page.detailsTruncated && (
            <span>
              {zh ? "部分执行明细已省略" : "Some execution details omitted"}
            </span>
          )}
        </>
      )}
      {upgradeable && (
        <button
          className="underline"
          disabled={busy}
          onClick={() => void upgrade()}
        >
          {busy
            ? zh
              ? "正在升级…"
              : "Upgrading…"
            : zh
              ? "升级高性能历史"
              : "Upgrade history"}
        </button>
      )}
      {page &&
        messages
          ?.filter((message) =>
            message.historyProjection?.omittedFields.includes("content"),
          )
          .map((message) => (
            <HistoryTextReader
              key={message.id}
              sessionId={session.id}
              messageId={message.id}
              revision={page.revision}
              zh={zh}
            />
          ))}
      {error && <span className="text-danger">{error}</span>}
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
