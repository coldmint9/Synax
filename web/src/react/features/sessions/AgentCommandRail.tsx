import { useAgentSessionStore } from "./agentSessionStore";
import { SessionComposer } from "./SessionComposer";
import { SessionFileChangeIsland } from "./SessionFileChangeIsland";
import {
  GoalQuickApproval,
  listPendingGoalPermissions,
} from "../wiki/goal/GoalQuickApproval";
import { isGoalModeSession } from "./sessionBuckets";

export function AgentCommandRail({
  sessionId,
  readingHistory = false,
  projectId,
  focus,
  insetLeft,
  insetRight,
}: {
  sessionId: string;
  readingHistory?: boolean;
  projectId: string;
  focus: boolean;
  insetLeft: number;
  insetRight: number;
}) {
  const session = useAgentSessionStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const permissions = useAgentSessionStore((state) => state.permissions);
  const replyPermission = useAgentSessionStore(
    (state) => state.replyPermission,
  );
  const pendingPermissions = listPendingGoalPermissions(permissions);
  const goalMode = Boolean(session && isGoalModeSession(session));

  if (!session || (!goalMode && pendingPermissions.length === 0)) return null;

  return (
    <div
      className="agent-command-rail"
      data-focus={focus ? "true" : "false"}
      style={{ left: insetLeft, right: insetRight }}
    >
      <div className="agent-command-rail-inner">
        {pendingPermissions.length > 0 ? (
          <GoalQuickApproval
            permissions={permissions}
            onReply={(permissionId, reply) =>
              void replyPermission(permissionId, reply)
            }
            variant="strip"
            showIndicator
          />
        ) : null}

        {goalMode ? (
          <SessionComposer
            session={session}
            readingHistory={readingHistory}
            projectId={projectId}
            layout="focusRail"
            statusSlot={
              <SessionFileChangeIsland
                sessionId={session.id}
                isRunning={session.status === "running"}
              />
            }
          />
        ) : null}
      </div>
    </div>
  );
}
