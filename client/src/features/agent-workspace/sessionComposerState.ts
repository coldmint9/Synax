import type { AgentSession } from "../../adapters/transport/agentRuntime";
import type { PermissionDecision } from "../../adapters/transport/agentRuntime";
import { listPendingPermissions } from "./dock/AgentQuickApproval";
import { isAcpSession, readSynaxSessionMode } from "./synaxSessionTypes";

export function patchAgentSession(
  session: AgentSession,
  patch: Partial<AgentSession>,
): AgentSession {
  const merged = { ...session, ...patch };
  const legacyStatus = (merged as { status: string }).status;
  const next: AgentSession =
    legacyStatus === "blocked"
      ? { ...merged, status: "completed" }
      : merged;
  if (next.profileId !== "synax" && next.profileId !== "goal") return next;
  if (next.status === "stopping") return { ...next, status: "running" };
  // "paused" stays paused: a resting state that still offers one-click resume.
  if (next.status === "paused") return next;
  // A failed run keeps its own state so the session list can flag it with a red
  // dot; cancelled/interrupted still fold into the resting state.
  if (["cancelled", "interrupted"].includes(next.status)) {
    return { ...next, status: "completed" };
  }
  return next;
}

export function isSessionComposerLocked(
  session: AgentSession | undefined,
  options: {
    submitting?: boolean;
    hasPendingPermissions?: boolean;
    hasPendingInteractions?: boolean;
    allowWaitingInputForPlanApproval?: boolean;
  } = {},
): boolean {
  if (options.submitting) return true;
  if (!session) return false;
  if (session.status === "stopping" || session.status === "queued") return true;
  if (
    options.hasPendingInteractions ||
    (session.status === "waiting_input" &&
      !options.allowWaitingInputForPlanApproval)
  )
    return true;

  if (session.status === "waiting_permission") {
    return options.hasPendingPermissions ?? false;
  }

  return session.status === "running" && Boolean(session.activeRunId);
}

export function canSwitchSessionMode(
  session: AgentSession | undefined,
  options: {
    hasPendingInteractions?: boolean;
    hasPendingPermissions?: boolean;
    acp?: boolean;
  } = {},
): boolean {
  if (
    options.acp ||
    options.hasPendingInteractions ||
    options.hasPendingPermissions
  )
    return false;
  if (!session) return true;
  if (
    isAcpSession(session) ||
    session.parentSessionId ||
    readSynaxSessionMode(session.sessionMetadata) === "plan_node"
  )
    return false;
  if (session.profileId !== "synax" && session.profileId !== "goal")
    return false;
  return (
    !session.activeRunId &&
    !session.pendingResumeToken &&
    !["running", "queued", "waiting_permission", "waiting_input"].includes(
      session.status,
    )
  );
}

export function canEnqueueSessionInput(
  session: AgentSession | undefined,
): boolean {
  if (!session) return false;
  if (session.status === "running" && Boolean(session.activeRunId)) return true;
  if (session.status === "waiting_permission") return true;
  return false;
}

/** Statuses where the send key becomes a resume (play) control. A failed Run is
 *  not resumable server-side (it has no pending Run), so it never gets one. */
export function isSessionResumable(session: AgentSession | undefined): boolean {
  return Boolean(
    session &&
      (session.status === "interrupted" || session.status === "paused"),
  );
}

export function sessionHasPendingPermissions(
  sessionId: string | undefined,
  selectedSessionId: string | null,
  permissions: PermissionDecision[],
): boolean {
  if (!sessionId || sessionId !== selectedSessionId) return false;
  return listPendingPermissions(permissions).length > 0;
}
