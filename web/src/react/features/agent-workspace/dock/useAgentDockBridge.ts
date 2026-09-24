import { useEffect } from "react";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
import { subscribe } from "../../../../lib/api/runtimeEventBus";
import { addSessionLiveListener } from "../../../../lib/api/sessionLiveClient";
import { useAgentSessionStore, scheduleSessionRefresh } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import {
  applyDockLiveEvent,
  applyDockSessionPatch,
  fetchDockSessionPermissions,
} from "./dockSessionStream";

export function useAgentDockBridge(_projectId: string) {
  const session = useAgentDockStore((s) => s.session);
  const dockState = useAgentDockStore((s) => s.dockState);
  const sessionId = session.sessionId;
  const isChat = dockState === "expanded";

  useEffect(() => {
    if (!sessionId) return;

    void agentRuntimeApi
      .getSession(sessionId)
      .then(({ session }) => {
        useAgentDockStore.setState((s) => {
          if (s.session.sessionId !== sessionId) return s;
          return {
            session: {
              ...s.session,
              title: session.title ?? s.session.title,
            },
          };
        });
      })
      .catch(() => {});

    const releaseLive = addSessionLiveListener(sessionId, (event) => {
      useAgentDockStore.setState((s) =>
        s.session.sessionId !== sessionId
          ? s
          : {
              session: applyDockLiveEvent(s.session, event),
            },
      );
    });

    return releaseLive;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    return subscribe({
      events: {
        session_changed: (event) => {
          const data = JSON.parse(event.data) as {
            sessionId: string;
            patch?: Record<string, unknown>;
          };
          if (data.sessionId !== sessionId || !data.patch) return;

          useAgentDockStore.setState((s) =>
            s.session.sessionId !== sessionId
              ? s
              : {
                  session: applyDockSessionPatch(s.session, data.patch!),
                },
          );

          const nextStatus = data.patch.status;
          if (nextStatus === "waiting_permission" || nextStatus === "running") {
            void fetchDockSessionPermissions(sessionId).then((items) => {
              useAgentDockStore.setState((s) =>
                s.session.sessionId !== sessionId
                  ? s
                  : {
                      session: { ...s.session, permissions: items },
                    },
              );
            });
          }

          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (selected === sessionId) {
            scheduleSessionRefresh(sessionId, "detail");
          }
        },
        session_step_completed: (event) => {
          const data = JSON.parse(event.data) as { sessionId: string };
          if (data.sessionId !== sessionId) return;
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (selected === sessionId) {
            scheduleSessionRefresh(sessionId, "detail");
          }
        },
      },
    });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !isChat) return;
    void fetchDockSessionPermissions(sessionId).then((items) => {
      useAgentDockStore.setState((s) =>
        s.session.sessionId !== sessionId
          ? s
          : {
              session: { ...s.session, permissions: items },
            },
      );
    });
  }, [sessionId, isChat]);
}
