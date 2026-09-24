import { useWorkbenchPageActive } from "../../layouts/CachedWorkbenchPage";
import { useEffect, useRef } from "react";
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../../lib/api/sessionLiveClient";
import { useApiConnectivityStore } from "../../../lib/apiConnectivity";
import { useAgentSessionStore } from "./state/agentSessionStore";

export function useSessionLiveStream(sessionId: string | null) {
  const active = useWorkbenchPageActive();
  const apiReachable = useApiConnectivityStore((s) => s.apiReachable);

  const previous = useRef<{
    sessionId: string | null;
    reachable: typeof apiReachable;
  } | null>(null);
  useEffect(() => {
    const reconnecting =
      previous.current?.sessionId === sessionId &&
      previous.current?.reachable === "unreachable";
    previous.current = { sessionId, reachable: apiReachable };
    if (!sessionId || !active) return;
    if (apiReachable === "unreachable") return;

    ensureSessionLiveSubscription(sessionId, (event) => {
      useAgentSessionStore.getState().applyLiveEvent(event, sessionId);
    });

    // openPanel owns initial loading and cache freshness. Revalidating on every
    // selection defeats the cache and queues a duplicate transcript request.
    if (reconnecting) {
      void useAgentSessionStore
        .getState()
        .refreshSessions({ joinPending: true });
      void useAgentSessionStore.getState().refreshDetail();
    }

    return () => {
      releaseSessionLiveSubscription();
    };
  }, [sessionId, apiReachable, active]);
}
