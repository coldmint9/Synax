import type { AgentSession } from "../api/agentRuntime";

export type SessionNotificationKind =
  | "completed"
  | "input"
  | "approval"
  | "failed";
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
export interface DesktopNotificationBridge {
  showDesktopNotification: (
    payload: SessionNotificationPayload,
  ) => Promise<boolean>;
  setDesktopNotificationsEnabled: (enabled: boolean) => void;
  dismissDesktopNotification: (sessionId: string) => void;
  onDesktopNotificationOpen: (
    callback: (target: SessionNotificationTarget) => void,
  ) => () => void;
}
export function desktopNotificationBridge():
  | DesktopNotificationBridge
  | undefined {
  const api = (
    window as Window & { electronAPI?: Partial<DesktopNotificationBridge> }
  ).electronAPI;
  return typeof api?.showDesktopNotification === "function" &&
    typeof api.setDesktopNotificationsEnabled === "function" &&
    typeof api.dismissDesktopNotification === "function" &&
    typeof api.onDesktopNotificationOpen === "function"
    ? (api as DesktopNotificationBridge)
    : undefined;
}
export function validNotificationTarget(
  value: unknown,
): value is SessionNotificationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    [target.projectId, target.sessionId].every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id),
    ) &&
    ["completed", "input", "approval", "failed"].includes(String(target.kind))
  );
}
export function notificationKind(
  status: string,
): SessionNotificationKind | undefined {
  if (status === "waiting_input") return "input";
  if (status === "waiting_permission") return "approval";
  if (status === "completed" || status === "failed") return status;
}
interface Observation {
  status: string;
  marker?: string;
  sequence: number;
  resolving: boolean;
  handled: boolean;
}
/** Status transitions, not individual SSE patches, define notification episodes. */
export class SessionNotificationTracker {
  private states = new Map<string, Observation>();
  private sequence = 0;
  observe(id: string, patch: Record<string, unknown>): Observation | undefined {
    if (typeof patch.status !== "string") return;
    const previous = this.states.get(id);
    const token =
      patch.status === "completed"
        ? patch.completedAt
        : patch.pendingResumeToken;
    const marker = typeof token === "string" && token ? token : undefined;
    if (
      previous?.status === patch.status &&
      (!marker || marker === previous.marker)
    )
      return previous;
    const next = {
      status: patch.status,
      marker,
      sequence: ++this.sequence,
      resolving: false,
      handled: false,
    };
    this.states.delete(id);
    this.states.set(id, next);
    if (this.states.size > 512)
      this.states.delete(this.states.keys().next().value!);
    return next;
  }
  isCurrent(id: string, state: Observation): boolean {
    return this.states.get(id) === state;
  }
  remove(id: string): void {
    this.states.delete(id);
  }
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
  session: AgentSession,
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
      }
    : {
        completed: "Session completed",
        input: "Your input is needed",
        approval: "Approval required",
        failed: "Session failed",
      };
  const fallback = zh
    ? {
        completed: "点击查看执行结果。",
        input: "点击打开会话并回答问题。",
        approval: "点击查看待确认的操作。",
        failed: "点击查看详情并继续处理。",
      }
    : {
        completed: "Open the session to view the result.",
        input: "Open the session to answer the pending question.",
        approval: "Open the session to review the operation.",
        failed: "Open the session for details.",
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
