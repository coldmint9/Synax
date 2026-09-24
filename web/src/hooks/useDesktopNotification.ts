import { useEffect, useRef } from "react";
import { useShellStore } from "../react/state/shellStore";
import { useNotificationStore } from "../react/state/notificationStore";
import { useAgentSessionStore } from "../react/features/agent-workspace/state/agentSessionStore";
import { agentRuntimeApi } from "../lib/api/agentRuntime";
import { subscribe } from "../lib/api/runtimeEventBus";
import {
  desktopNotificationBridge,
  notificationKind,
  sessionNotificationPayload,
  SessionNotificationTracker,
  validNotificationTarget,
  type SessionNotificationTarget,
  type SessionNotificationPayload,
} from "../lib/notifications/sessionNotifications";

// Retain dedupe across project changes and Workbench remounts. Never replay history on connection.
const tracker = new SessionNotificationTracker();
const browserNotices = new Map<string, Notification>();
function dismiss(sessionId: string): void {
  desktopNotificationBridge()?.dismissDesktopNotification(sessionId);
  const notice = browserNotices.get(sessionId);
  browserNotices.delete(sessionId);
  notice?.close();
}
async function sendNotification(
  payload: SessionNotificationPayload,
  onOpen: (target: SessionNotificationTarget) => void,
): Promise<void> {
  if (!useShellStore.getState().preferences.notifications) return;
  const native = desktopNotificationBridge();
  if (native) {
    await native.showDesktopNotification(payload);
    return;
  }
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    (document.visibilityState === "visible" && document.hasFocus())
  )
    return;
  dismiss(payload.sessionId);
  const notice = new Notification(payload.title, {
    body: payload.body,
    icon: "/icon-192.png",
    tag: payload.id,
  });
  browserNotices.set(payload.sessionId, notice);
  notice.onclick = () => {
    if (
      !useShellStore.getState().preferences.notifications ||
      browserNotices.get(payload.sessionId) !== notice
    )
      return;
    window.focus();
    onOpen(payload);
    dismiss(payload.sessionId);
  };
  notice.onclose = () => {
    if (browserNotices.get(payload.sessionId) === notice)
      browserNotices.delete(payload.sessionId);
  };
  if (browserNotices.size > 64) dismiss(browserNotices.keys().next().value!);
}

export function useDesktopNotification(
  onOpenSession: (target: SessionNotificationTarget) => void,
) {
  const enabled = useShellStore((s) => s.preferences.notifications);
  const wasEnabled = useRef(enabled);
  const onOpen = useRef(onOpenSession);
  onOpen.current = onOpenSession;

  useEffect(() => {
    const native = desktopNotificationBridge();
    return native?.onDesktopNotificationOpen((target) => {
      if (
        validNotificationTarget(target) &&
        useShellStore.getState().preferences.notifications
      )
        onOpen.current(target);
    });
  }, []);

  useEffect(() => {
    const native = desktopNotificationBridge();
    native?.setDesktopNotificationsEnabled(enabled);
    if (!enabled) for (const id of browserNotices.keys()) dismiss(id);
    // Native notifications use OS app permissions, never the Chromium permission prompt.
    if (!native && enabled && !wasEnabled.current) {
      const zh = useShellStore.getState().preferences.locale === "zh";
      if (
        typeof Notification === "undefined" ||
        Notification.permission === "denied"
      ) {
        useShellStore.getState().setNotifications(false);
        useNotificationStore
          .getState()
          .push({
            type: "warning",
            duration: 5000,
            message: zh
              ? "浏览器通知不可用，请检查浏览器的通知权限。"
              : "Browser notifications are unavailable. Check the browser's notification permissions.",
          });
      } else if (Notification.permission === "default") {
        void Notification.requestPermission()
          .then((permission) => {
            if (permission !== "granted")
              useShellStore.getState().setNotifications(false);
          })
          .catch(() => useShellStore.getState().setNotifications(false));
      }
    }
    wasEnabled.current = enabled;
  }, [enabled]);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribe({
      events: {
        session_deleted: (event) => {
          try {
            const { sessionId } = JSON.parse(event.data);
            if (typeof sessionId !== "string") return;
            tracker.remove(sessionId);
            dismiss(sessionId);
          } catch {
            /* malformed SSE payload */
          }
        },
        session_archived: (event) => {
          try {
            const { sessionId } = JSON.parse(event.data);
            if (typeof sessionId !== "string") return;
            tracker.remove(sessionId);
            dismiss(sessionId);
          } catch {
            /* malformed SSE payload */
          }
        },
        session_changed: (event) => {
          let data: { sessionId?: unknown; patch?: Record<string, unknown> };
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          if (
            !data ||
            typeof data.sessionId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,200}$/.test(data.sessionId) ||
            !data.patch ||
            typeof data.patch !== "object"
          )
            return;
          const id = data.sessionId;
          const state = tracker.observe(id, data.patch);
          if (!state || state.handled || state.resolving) return;
          const kind = notificationKind(state.status);
          dismiss(id);
          if (!kind || !useShellStore.getState().preferences.notifications) {
            state.handled = true;
            return;
          }
          state.resolving = true;
          // Global events can concern another project and usually omit its ID/title.
          // Resolve the actual session; never route using the currently viewed workspace.
          void agentRuntimeApi
            .getSession(id)
            .then(({ session }) => session)
            .catch(() =>
              useAgentSessionStore
                .getState()
                .sessions.find((session) => session.id === id),
            )
            .then(async (session) => {
              if (!active || !tracker.isCurrent(id, state)) return;
              state.handled = true;
              if (
                !session ||
                session.id !== id ||
                session.status !== state.status ||
                !useShellStore.getState().preferences.notifications
              )
                return;
              if (
                state.marker &&
                state.marker !==
                  (state.status === "completed"
                    ? session.completedAt
                    : session.pendingResumeToken)
              )
                return;
              state.marker ??=
                (state.status === "completed"
                  ? session.completedAt
                  : session.pendingResumeToken) ?? undefined;
              // Child workers should not flood the desktop when they finish; actionable waits still notify.
              if (
                session.parentSessionId &&
                (kind === "completed" || kind === "failed")
              )
                return;
              const payload = sessionNotificationPayload(
                session,
                kind,
                useShellStore.getState().preferences.locale,
                state.sequence,
              );
              if (validNotificationTarget(payload))
                await sendNotification(payload, (target) =>
                  onOpen.current(target),
                );
            })
            .catch(() => {
              /* Delivery failure must not interrupt the session or create an unhandled rejection. */
            })
            .finally(() => {
              state.resolving = false;
            });
        },
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
