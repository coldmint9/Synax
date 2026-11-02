/**
 * Session lifecycle notifications shared by the renderer, the local runtime and
 * the desktop shell. Which statuses interrupt the user, how one episode is
 * identified and what the notice says live here once, so a notice produced in
 * the background process cannot drift from the one produced in the window.
 * Pure data only: no transport, no persistence, no platform APIs.
 */
export type SessionNotificationKind =
  | "completed"
  | "input"
  | "approval"
  | "failed"
  | "paused"
  | "interrupted"
  | "cancelled";

/** Every kind a delivery channel accepts; payload validators reuse it. */
export const SESSION_NOTIFICATION_KINDS: readonly SessionNotificationKind[] = [
  "completed",
  "input",
  "approval",
  "failed",
  "paused",
  "interrupted",
  "cancelled",
];

export interface SessionNotificationTarget {
  projectId: string;
  sessionId: string;
  kind: SessionNotificationKind;
}

export interface SessionNotificationPayload extends SessionNotificationTarget {
  id: string;
  title: string;
  body: string;
}

/** The session facts a notice may describe, as seen at the transition. */
export interface SessionNotificationSource {
  id: string;
  projectId: string;
  parentSessionId?: string | null;
  status: string;
  title?: string | null;
  completedAt?: string | null;
  pendingResumeToken?: string | null;
  resultSummary?: string | null;
  blockedReason?: string | null;
}

/**
 * A session is "suspended or settled" once the run no longer needs the machine:
 * it either waits on the user or it has stopped. Every one of these transitions
 * deserves a desktop notice, not just a quiet dot in the list.
 */
const NOTIFIABLE_STATUSES: ReadonlyMap<string, SessionNotificationKind> = new Map<
  string,
  SessionNotificationKind
>([
  ["waiting_input", "input"],
  ["waiting_permission", "approval"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["paused", "paused"],
  ["interrupted", "interrupted"],
  ["cancelled", "cancelled"],
]);

const WAITING_STATUSES = new Set(["waiting_input", "waiting_permission"]);

export function isSessionNotificationKind(
  value: unknown,
): value is SessionNotificationKind {
  return SESSION_NOTIFICATION_KINDS.includes(value as SessionNotificationKind);
}

export function notificationKind(
  status: string,
): SessionNotificationKind | undefined {
  return NOTIFIABLE_STATUSES.get(status);
}

/**
 * Identity of one notification episode. A pending question is identified by
 * its resume token, a settled run by its completion time, so a new question or
 * a new run on the same session always notifies again.
 */
export function notificationMarker(
  status: string,
  value: { completedAt?: unknown; pendingResumeToken?: unknown },
): string | undefined {
  const token = WAITING_STATUSES.has(status)
    ? value.pendingResumeToken
    : value.completedAt;
  return typeof token === "string" && token ? token : undefined;
}

/**
 * Child workers should not flood the desktop when they settle; a child that
 * waits on the user is still actionable and keeps interrupting.
 */
export function quietSessionNotification(
  session: { parentSessionId?: string | null },
  kind: SessionNotificationKind,
): boolean {
  if (!session.parentSessionId) return false;
  return kind !== "input" && kind !== "approval";
}

const text = (value: string | null | undefined, limit: number) =>
  Array.from(
    (value ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, limit)
    .join("");

export function sessionNotificationPayload(
  session: SessionNotificationSource,
  kind: SessionNotificationKind,
  locale: "zh" | "en",
  sequence: number,
): SessionNotificationPayload {
  const zh = locale === "zh";
  const labels = zh
    ? {
        completed: "会话已完成",
        input: "需要你提供输入",
        approval: "需要你审批",
        failed: "会话执行失败",
        paused: "会话已暂停",
        interrupted: "会话已中断",
        cancelled: "会话已取消",
      }
    : {
        completed: "Session completed",
        input: "Your input is needed",
        approval: "Approval required",
        failed: "Session failed",
        paused: "Session paused",
        interrupted: "Session interrupted",
        cancelled: "Session canceled",
      };
  const fallback = zh
    ? {
        completed: "点击查看执行结果。",
        input: "点击打开会话并回答问题。",
        approval: "点击查看待确认的操作。",
        failed: "点击查看详情并继续处理。",
        paused: "点击查看进度，可随时继续。",
        interrupted: "点击查看中断前的执行结果。",
        cancelled: "点击查看详情。",
      }
    : {
        completed: "Open the session to view the result.",
        input: "Open the session to answer the pending question.",
        approval: "Open the session to review the operation.",
        failed: "Open the session for details.",
        paused: "Open the session to review it and resume when ready.",
        interrupted: "Open the session to review where it stopped.",
        cancelled: "Open the session for details.",
      };
  const title = text(session.title, 100);
  const summary = text(
    kind === "completed"
      ? session.resultSummary
      : (session.blockedReason ?? session.resultSummary),
    240,
  );
  return {
    id: `${session.id}:${kind}:${session.pendingResumeToken ?? session.completedAt ?? sequence}`,
    projectId: session.projectId,
    sessionId: session.id,
    kind,
    title:
      title && !/^new (session|chat|agent)$/i.test(title)
        ? title
        : `Synax · ${labels[kind]}`,
    body: `${labels[kind]}\n${summary || fallback[kind]}`,
  };
}
