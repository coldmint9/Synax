import { SearchHighlight } from "./SearchHighlight";
import { PixelLoader } from "./LoadingState";
import { memo } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { copyTextToClipboard } from "../../../lib/clipboard";
import { useNotificationStore } from "../../state/notificationStore";
import { useContextMenu } from "../../components/context-menu/ContextMenuProvider";
import { useLocale } from "../../../hooks/useLocale";
import { useShellStore } from "../../state/shellStore";
import type { SessionTreeNode } from "./useSessionList";
import {
  isSessionUnread,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import {
  resolveSessionUserInput,
  useSessionDisplayTitle,
} from "./useSessionDisplayTitle";

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
      if (message.role === "assistant")
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
  const displayMode = useShellStore(
    (state) => state.preferences.sessionListDisplayMode,
  );
  const { session, depth, children } = node;
  const title = useSessionDisplayTitle(session);
  const hasKids = children.length > 0;
  const isRunning =
    session.status === "running" || session.status === "stopping";
  const unread = useAgentSessionStore((state) =>
    isSessionUnread(session, state.readSessionMarkers),
  );
  const showStatusDot = session.status !== "completed" || unread;
  const needsUserInput = session.status === "waiting_input";
  const menu = useContextMenu(() => ({
    label: title,
    entries: [
      { type: "action", id: "open", label: t("contextOpen"), run: () => onSelect(session.id) },
      { type: "action", id: "copy-id", label: t("contextCopySessionId"), run: async () => {
        if (!await copyTextToClipboard(session.id)) throw new Error(t("contextCopyFailed"));
        useNotificationStore.getState().push({ type: "success", message: t("contextCopied"), duration: 1800 });
      } },
      ...(onDelete ? [
        { type: "separator" } as const,
        { type: "action", id: "archive", label: t("sessionDelete"), restoreFocus: false, run: () => onDelete(session.id) } as const,
      ] : []),
    ],
  }));

  return (
    <div
      className={`session-list-item${isSelected ? " session-list-item--active" : ""}${depth > 0 ? " session-list-item--child" : ""}${displayMode === "title" ? " session-list-item--title-only" : ""}`}
      style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}
      data-unread={unread || undefined}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
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
          {needsUserInput && (
            <span className="session-list-needs-input">
              {t("sessionNeedsUserInput")}
            </span>
          )}
        </span>
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
        ) : displayMode === "preview" ? (
          <SessionPreview session={session} />
        ) : null}
      </button>
      <button
        type="button"
        className="session-list-delete"
        aria-label={t("contextMoreActions")}
        aria-haspopup="menu"
        onClick={(event) => menu.openFromAnchor(event.currentTarget)}
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
});
