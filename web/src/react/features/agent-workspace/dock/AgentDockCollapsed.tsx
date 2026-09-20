import { useEffect, useMemo, useState } from "react";
import { AgentWorkingIndicator } from "./AgentWorkingIndicator";
import {
  AgentQuickApproval,
  listPendingPermissions,
} from "./AgentQuickApproval";
import type { PermissionDecision } from "../../../../lib/api/agentRuntime";
import type { DockSessionStatus, DockToolCall } from "./dockSessionStream";

interface Props {
  status: DockSessionStatus;
  toolCalls: DockToolCall[];
  thinking: string;
  sessionTitle: string;
  permissions: PermissionDecision[];
  onReplyPermission?: (
    permissionId: string,
    reply: "once" | "always" | "reject",
  ) => void;
  hovered?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function buildCarouselItems(
  sessionTitle: string,
  toolCalls: DockToolCall[],
  thinking: string,
): string[] {
  const items: string[] = [];
  const title = sessionTitle.trim();
  if (title) items.push(title);
  const tail = thinking.trim();
  if (tail) items.push(tail.slice(-100));
  for (const call of toolCalls.slice(-4)) {
    items.push(`${call.tool} · ${call.outputSummary ?? call.summary}`);
  }
  if (items.length === 0 && title) items.push(title);
  return items;
}

export function AgentDockCollapsed({
  status,
  toolCalls,
  thinking,
  sessionTitle,
  permissions,
  onReplyPermission,
  hovered = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const pending = listPendingPermissions(permissions);
  const hasPendingApproval = pending.length > 0 && Boolean(onReplyPermission);
  const items = useMemo(
    () => buildCarouselItems(sessionTitle, toolCalls, thinking),
    [sessionTitle, toolCalls, thinking],
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [items]);

  useEffect(() => {
    if (items.length <= 1 || hasPendingApproval) return;
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, 2800);
    return () => window.clearInterval(timer);
  }, [items, hasPendingApproval]);

  const isRunning = status === "running";
  const isWaiting = status === "waiting_permission";
  const text = items[index] ?? sessionTitle;

  if (hasPendingApproval) {
    return (
      <div
        className={`agent-dock-mini-inner agent-dock-mini-inner--approval ${hovered ? "agent-dock-mini-inner--hover" : ""}`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <AgentQuickApproval
          permissions={permissions}
          onReply={onReplyPermission!}
          variant="mini"
          showIndicator
          onLabelClick={onClick}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`agent-dock-mini-inner flex h-full w-full items-center gap-2 px-3 text-[11px] transition-all duration-150 ${
        hovered ? "agent-dock-mini-inner--hover" : ""
      }`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={sessionTitle}
    >
      <AgentWorkingIndicator status={status} />
      <span className="relative min-h-[1.25rem] min-w-0 flex-1 overflow-hidden text-muted-foreground">
        <span
          key={index}
          className="agent-dock-mini-carousel-item absolute inset-0 flex items-center truncate"
        >
          <span
            className={`truncate ${isRunning || isWaiting ? "text-foreground" : ""}`}
          >
            {text}
          </span>
        </span>
      </span>
      <span
        className={`shrink-0 text-[9px] transition-transform duration-150 ${hovered ? "text-muted-foreground/70" : "text-muted-foreground/40"}`}
      >
        ▲
      </span>
    </button>
  );
}
