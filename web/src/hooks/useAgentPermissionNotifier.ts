import { useEffect, useRef } from "react";
import { useNotificationStore } from "../react/state/notificationStore";
import { subscribe } from "../lib/api/runtimeEventBus";

export function useAgentPermissionNotifier(
  projectId: string | null,
  navigateToSession: (sessionId: string) => void,
  visibleSessionId: string | null = null,
) {
  const notifiedRef = useRef(new Set<string>());
  const visibleRef = useRef(visibleSessionId);
  visibleRef.current = visibleSessionId;

  useEffect(() => {
    if (!visibleSessionId) return;
    const toastId = `perm-global-${visibleSessionId}`;
    notifiedRef.current.delete(toastId);
    useNotificationStore.getState().remove(toastId);
  }, [visibleSessionId]);

  useEffect(() => {
    if (!projectId) return;

    return subscribe({
      events: {
        session_changed: (e) => {
          try {
            const data = JSON.parse(e.data) as {
              sessionId: string;
              patch?: {
                status?: string;
                blockedReason?: string;
                pendingResumeToken?: string;
              };
            };
            if (data.sessionId === visibleRef.current) return;
            if (data.patch?.status === "waiting_permission") {
              const toastId = `perm-global-${data.sessionId}`;
              if (notifiedRef.current.has(toastId)) return;
              notifiedRef.current.add(toastId);
              useNotificationStore.getState().push({
                id: toastId,
                type: "warning",
                message: `会话等待审批: ${data.patch.blockedReason ?? "权限请求"}`,
                duration: 0,
                actions: [
                  {
                    label: "前往审批",
                    variant: "primary",
                    onClick: () => {
                      notifiedRef.current.delete(toastId);
                      useNotificationStore.getState().remove(toastId);
                      navigateToSession(data.sessionId);
                    },
                  },
                ],
              });
            }
            if (
              data.patch?.status &&
              data.patch.status !== "waiting_permission"
            ) {
              const toastId = `perm-global-${data.sessionId}`;
              notifiedRef.current.delete(toastId);
              useNotificationStore.getState().remove(toastId);
            }
          } catch {
            /* ignore parse errors */
          }
        },
      },
    });
  }, [projectId, navigateToSession]);
}
