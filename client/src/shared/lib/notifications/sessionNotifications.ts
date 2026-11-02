import {
  SESSION_NOTIFICATION_KINDS,
  isSessionNotificationKind,
  notificationKind,
  notificationMarker,
  quietSessionNotification,
  sessionNotificationPayload,
  type SessionNotificationKind,
  type SessionNotificationPayload,
  type SessionNotificationTarget,
} from "../../../../../packages/contracts/session-notifications";

// The lifecycle rules and notice text are shared with the local runtime, which
// keeps notifying while this window is gone. Re-exported so callers keep one
// import surface.
export {
  SESSION_NOTIFICATION_KINDS,
  isSessionNotificationKind,
  notificationKind,
  notificationMarker,
  quietSessionNotification,
  sessionNotificationPayload,
};
export type {
  SessionNotificationKind,
  SessionNotificationPayload,
  SessionNotificationTarget,
};

export interface DesktopNotificationBridge {
  showDesktopNotification: (
    payload: SessionNotificationPayload,
  ) => Promise<boolean>;
  setDesktopNotificationsEnabled: (
    enabled: boolean,
    locale?: "zh" | "en",
  ) => void;
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
    ) && isSessionNotificationKind(target.kind)
  );
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
    const marker = notificationMarker(patch.status, patch);
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
