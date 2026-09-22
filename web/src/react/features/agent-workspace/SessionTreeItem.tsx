import { SearchHighlight } from "./SearchHighlight";
import { PixelLoader } from "./LoadingState";
import { memo } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import type { SessionTreeNode } from "./useSessionList";
import {
  isSessionUnread,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import {
  resolveSessionUserInput,
  useSessionDisplayTitle,
} from "./useSessionDisplayTitle";
import {
  isSessionPromptUserMessage,
  isSystemInjectedMessage,
} from "./buildConversationTimeline";

const DOT: Record<string, string> = {
  running: "bg-run",
  stopping: "bg-run",
  completed: "bg-success",
  failed: "bg-destructive",
  waiting_permission: "bg-warning",
  waiting_input: "bg-warning",
  interrupted: "bg-warning/60",
  queued: "bg-muted-foreground/60",
  cancelled: "bg-muted-foreground/40",
};

type Translator = ReturnType<typeof useLocale>["t"];

function relTime(iso: string, t: Translator): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return "";
  const m = Math.max(0, Math.floor(elapsed / 60000));
  if (m < 60) return t("timeMinutesAgo", { count: m });
  if (m < 1440) return t("timeHoursAgo", { count: Math.floor(m / 60) });
  return t("timeDaysAgo", { count: Math.floor(m / 1440) });
}

interface Props {
  node: SessionTreeNode;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onDelete?: (id: string) => void;
  onCancel?: (id: string) => void;
}

function SessionPreview({ session }: { session: SessionTreeNode["session"] }) {
  // Reuse already loaded messages; list rows must not fetch session transcripts.
  const latestMessage = useAgentSessionStore((state) => {
    const messages =
      state.selectedSessionId === session.id
        ? state.messages
        : state.sessionDetailCache[session.id]?.messages;
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const message = messages![i];
      if (message.sessionId !== session.id || !message.content.trim()) continue;
      if (
        message.role === "assistant" ||
        (message.role === "user" &&
          !isSessionPromptUserMessage(message) &&
          !isSystemInjectedMessage(message))
      )
        return message.content;
    }
    return "";
  });
  const preview = (
    latestMessage ||
    session.resultSummary?.trim() ||
    session.blockedReason?.trim() ||
    resolveSessionUserInput(session) ||
    session.prompt
  )
    .replace(/\s+/g, " ")
    .trim();

  return (
    <span className="session-list-preview" title={preview}>
      {preview || "\u00a0"}
    </span>
  );
}

export const SessionTreeItem = memo(function SessionTreeItem({
  node,
  isSelected,
  onSelect,
  onToggleExpand,
  onDelete,
}: Props) {
  const { t } = useLocale();
  const { session, depth, children } = node;
  const title = useSessionDisplayTitle(session);
  const hasKids = children.length > 0;
  const isRunning =
    session.status === "running" || session.status === "stopping";
  const unread = useAgentSessionStore((state) =>
    isSessionUnread(session, state.readSessionMarkers),
  );
  const showStatusDot = session.status !== "completed" || unread;

  return (
    <div
      className={`session-list-item${isSelected ? " session-list-item--active" : ""}${depth > 0 ? " session-list-item--child" : ""}`}
      style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}
      data-unread={unread || undefined}
    >
      {hasKids && (
        <button
          type="button"
          className="session-list-expand"
          onClick={() => onToggleExpand(session.id)}
          aria-label={t(node.expanded ? "sessionCollapse" : "sessionExpand")}
          aria-expanded={node.expanded}
        >
          {node.expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
      )}
      <button
        type="button"
        className="session-list-select"
        onClick={() => onSelect(session.id)}
        aria-current={isSelected ? "true" : undefined}
      >
        <span className="session-list-indicator" aria-hidden="true">
          {isRunning ? (
            <PixelLoader />
          ) : showStatusDot ? (
            <span
              className={`session-list-dot ${DOT[session.status] ?? "bg-muted-foreground/50"}`}
            />
          ) : null}
        </span>
        <span className="session-list-title" title={title}>
          <SearchHighlight text={title} query={node.searchQuery} />
        </span>
        <time
          className="session-list-time"
          dateTime={session.updatedAt}
          title={new Date(session.updatedAt).toLocaleString()}
        >
          {relTime(session.updatedAt, t)}
        </time>
        {node.searchSnippet !== undefined ? (
          <span
            className="session-list-preview session-list-preview--search"
            title={node.searchSnippet}
          >
            <SearchHighlight
              text={node.searchSnippet}
              query={node.searchQuery}
            />
          </span>
        ) : (
          <SessionPreview session={session} />
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          className="session-list-delete"
          aria-label={t("sessionDelete")}
          onClick={() => onDelete(session.id)}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
});
