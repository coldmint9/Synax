import { useWorkbenchPageActive } from "../../app/layouts/CachedWorkbenchPage";
import { useEffect, useRef } from "react";
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../adapters/transport/sessionLiveClient";
import { useApiConnectivityStore } from "../../shared/lib/apiConnectivity";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { enqueueLiveEvent } from "./state/liveEventQueue";

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
      // Records are collected for the frame and committed together.
      enqueueLiveEvent(event, sessionId);
    });

    // openPanel owns initial loading and cache freshness. Revalidating on every
    // selection defeats the cache and queues a duplicate transcript request.
    // After a reconnect only the open session is reconciled: its callbacks may
    // have been missed, while the page itself is never re-read.
    if (reconnecting) {
      void useAgentSessionStore.getState().syncSessionSummary(sessionId);
      void useAgentSessionStore.getState().refreshDetail();
    }

    return () => {
      releaseSessionLiveSubscription();
    };
  }, [sessionId, apiReachable, active]);
}
