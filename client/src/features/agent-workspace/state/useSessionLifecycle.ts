import { useLayoutEffect, useRef, useState } from "react";
import {
  sessionLifecycleTransition,
  sessionPhase,
  type SessionLifecycleSnapshot,
  type SessionLifecycleTransition,
  type SessionPhase,
} from "./sessionLifecycle";

/**
 * Session lifecycle hook: turns the live transcript snapshot of one scope into
 * `idle | working | replying | settled` and reports each transition once.
 *
 * Features subscribe here instead of re-deriving "is the reply done" from
 * timers or status polling. The snapshot is dropped across scopes (session or
 * draft switch), and the mount snapshot never reports a transition, so a
 * feature cannot react to activity that happened before it was mounted.
 */
export function useSessionLifecycle(
  scope: string,
  activity: SessionLifecycleSnapshot,
  onTransition: (transition: SessionLifecycleTransition) => void,
): SessionPhase {
  const [phase, setPhase] = useState<SessionPhase>(() =>
    sessionPhase(activity, "idle"),
  );
  const previous = useRef(activity);
  const scopeRef = useRef(scope);
  const handler = useRef(onTransition);
  handler.current = onTransition;

  useLayoutEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      previous.current = activity;
      setPhase(sessionPhase(activity, "idle"));
      return;
    }
    const last = previous.current;
    previous.current = activity;
    setPhase((value) => sessionPhase(activity, value));
    const transition = sessionLifecycleTransition(last, activity);
    if (transition) handler.current(transition);
  });

  return phase;
}
