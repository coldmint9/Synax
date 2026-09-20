import { useLayoutEffect, useRef } from "react";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionComposer } from "./SessionComposer";
import { SessionFileChangeIsland } from "./SessionFileChangeIsland";
import {
  AgentQuickApproval,
  listPendingPermissions,
} from "./dock/AgentQuickApproval";
import { isAgentWorkspaceSession } from "./sessionBuckets";

export function AgentCommandRail({
  sessionId,
  readingHistory = false,
  projectId,
  focus,
  insetLeft,
  insetRight,
  showFileSummary = true,
}: {
  sessionId: string;
  readingHistory?: boolean;
  projectId: string;
  focus: boolean;
  insetLeft: number;
  insetRight: number;
  showFileSummary?: boolean;
}) {
  const session = useAgentSessionStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const permissions = useAgentSessionStore((state) => state.permissions);
  const replyPermission = useAgentSessionStore(
    (state) => state.replyPermission,
  );
  const pendingPermissions = listPendingPermissions(
    permissions.filter((p) => p.sessionId === sessionId),
  );
  const workspaceSession = Boolean(session && isAgentWorkspaceSession(session));
  const visible = Boolean(
    session && (workspaceSession || pendingPermissions.length),
  );
  const railRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rail = railRef.current;
    const page = rail?.closest<HTMLElement>(".agent-page-shell");
    if (!rail || !page || !visible) return;
    const scroll = page.querySelector<HTMLElement>(".session-chat-scroll");
    const measure = () => {
      if (!rail.isConnected || page.clientHeight <= 0) return;
      const pinned =
        scroll &&
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48;
      page.style.setProperty(
        "--agent-command-rail-max-height",
        `${Math.max(0, page.clientHeight - 24)}px`,
      );
      page.style.setProperty(
        "--agent-command-rail-height",
        `${Math.ceil(rail.getBoundingClientRect().height) + 12}px`,
      );
      if (pinned && scroll) scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(rail);
    observer?.observe(page);
    return () => {
      observer?.disconnect();
      page.style.removeProperty("--agent-command-rail-height");
      page.style.removeProperty("--agent-command-rail-max-height");
    };
  }, [sessionId, visible]);

  if (!session || !visible) return null;

  return (
    <div
      ref={railRef}
      className="agent-command-rail"
      data-focus={focus ? "true" : "false"}
      style={{ left: insetLeft, right: insetRight }}
    >
      <div className="agent-command-rail-inner">
        {pendingPermissions.length > 0 ? (
          <AgentQuickApproval
            permissions={pendingPermissions}
            onReply={(permissionId, reply) =>
              replyPermission(permissionId, reply)
            }
            variant="strip"
            showIndicator
          />
        ) : null}

        {workspaceSession ? (
          <SessionComposer
            session={session}
            readingHistory={readingHistory}
            projectId={projectId}
            layout="focusRail"
            statusSlot={
              showFileSummary ? (
                <SessionFileChangeIsland
                  sessionId={session.id}
                  isRunning={session.status === "running"}
                />
              ) : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}
