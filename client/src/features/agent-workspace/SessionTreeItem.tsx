import { SearchHighlight } from "./SearchHighlight";
import { SessionListTitle } from "./SessionListTitle";
import { PixelLoader } from "./LoadingState";
import { memo, useMemo } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { copyTextToClipboard } from "../../adapters/electron/clipboard";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { useContextMenu } from "../../shared/ui/context-menu/ContextMenuProvider";
import { useLocale } from "../../shared/hooks/useLocale";
import { useShellStore } from "../../shared/state/shellStore";
import type { SessionTreeNode } from "./useSessionList";
import {
  isSessionUnread,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import {
  resolveSessionUserInput,
  useSessionDisplayTitle,
} from "./useSessionDisplayTitle";
import { getSubagentName } from "./SubagentIdentity";

const DOT: Record<string, string> = {
  running: "bg-run",
  stopping: "bg-run",
  completed: "bg-success",
  failed: "bg-destructive",
  waiting_permission: "bg-warning",
  waiting_input: "bg-warning",
  interrupted: "bg-warning/60",
  paused: "bg-warning/60",
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
  onTogglePin?: (id: string) => Promise<void>;
}

function SessionPreview({ session }: { session: SessionTreeNode["session"] }) {
  // Subscribe to the message array only. Computing the preview inside the
  // selector made every live delta scan every cached transcript, even when
  // that row could not change.
  const messages = useAgentSessionStore((state) =>
    state.selectedSessionId === session.id
      ? state.messages
      : state.sessionDetailCache[session.id]?.messages,
  );
  const latestMessage = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const message = messages![i];
      if (message.sessionId !== session.id || !message.content.trim()) continue;
      if (message.role === "assistant") return message.content;
    }
    return "";
  }, [messages, session.id]);
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
  onTogglePin,
}: Props) {
  const { t, locale } = useLocale();
  const displayMode = useShellStore(
    (state) => state.preferences.sessionListDisplayMode,
  );
  const { session, depth, children } = node;
  const title = depth > 0 ? getSubagentName(session) : useSessionDisplayTitle(session);
  const pinned = session.sessionMetadata?.pinned === true;
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
      {
        type: "action",
        id: "open",
        label: t("contextOpen"),
        run: () => onSelect(session.id),
      },
      {
        type: "action",
        id: "copy-id",
        label: t("contextCopySessionId"),
        run: async () => {
          if (!(await copyTextToClipboard(session.id)))
            throw new Error(t("contextCopyFailed"));
          useNotificationStore
            .getState()
            .push({
              type: "success",
              message: t("contextCopied"),
              duration: 1800,
            });
        },
      },
      ...(onTogglePin
        ? [
            {
              type: "action",
              id: "pin",
              label: pinned
                ? locale === "zh"
                  ? "取消置顶"
                  : "Unpin"
                : locale === "zh"
                  ? "置顶"
                  : "Pin",
              run: () => onTogglePin(session.id),
            } as const,
          ]
        : []),
      ...(onDelete
        ? [
            { type: "separator" } as const,
            {
              type: "action",
              id: "archive",
              label: t("sessionDelete"),
              restoreFocus: false,
              run: () => onDelete(session.id),
            } as const,
          ]
        : []),
    ],
  }));

  return (
    <div
      className={`session-list-item${isSelected ? " session-list-item--active" : ""}${depth > 0 ? " session-list-item--child" : ""}${displayMode === "title" ? " session-list-item--title-only" : ""}`}
      style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}
      data-tree-last={depth > 0 && node.isLastChild ? "true" : undefined}
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
        <SessionListTitle
          title={title}
          query={node.searchQuery}
          suffix={needsUserInput ? (
            <span className="session-list-needs-input">
              {t("sessionNeedsUserInput")}
            </span>
          ) : undefined}
        />
        {depth === 0 ? (
          <span
            className="session-list-preview-reveal"
            data-expanded={node.searchSnippet !== undefined || displayMode === "preview"}
            aria-hidden={node.searchSnippet === undefined && displayMode !== "preview"}
          >
            <span className="session-list-preview-reveal-content">
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
            </span>
          </span>
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
