import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { suggestNextInput } from "../../../adapters/transport/inputSuggestion";
import { useSessionLifecycle } from "../state/useSessionLifecycle";
import type { SessionLifecycleSnapshot } from "../state/sessionLifecycle";

/** Provider deadline: a hint that takes longer is not worth pre-filling. */
export const NEXT_INPUT_SUGGESTION_TIMEOUT_MS = 6_000;
const MAX_REPLY_CONTEXT_CHARS = 2_000;

interface Options {
  projectId: string;
  sessionId?: string;
  /** Chat composer with a live session; media and draft composers never hint. */
  enabled: boolean;
  /**
   * The composer cannot take input right now (an active turn owns it). The
   * guess still starts, because that is exactly when the reply is streaming;
   * it just stays hidden until the composer is usable again.
   */
  locked: boolean;
  /** Live reply activity of the open session. */
  activity: SessionLifecycleSnapshot;
  /** Assistant text already streamed in the current step. */
  replyText: string;
  content: string;
  model?: string;
  backendId?: string;
  onContentChange: (text: string) => void;
}

interface Hint {
  scope: string;
  text: string;
}

interface PendingRequest {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Pre-fill the composer with a guess of the user's next message.
 *
 * The request starts asynchronously the moment the final reply phase begins,
 * so the hint is usually ready when the turn hands the composer back. It is
 * cancelled outright when the provider misses its deadline, when the user
 * starts typing, or when the step turns out to be tool work instead of a reply.
 *
 * A turn that settles with an empty composer and no hint gets one fallback
 * attempt, so a missed phase signal or a failed provider call leaves no silent
 * hole where the pre-fill should have been.
 */
export function useNextInputSuggestion(options: Options) {
  const [hint, setHint] = useState<Hint | null>(null);
  const hintRef = useRef<Hint | null>(null);
  hintRef.current = hint;
  const request = useRef<PendingRequest | null>(null);
  // Read during the same render that reports a transition, not one render later.
  const latest = useRef(options);
  latest.current = options;
  const scopeOf = (value: Options) =>
    `${value.projectId}:${value.sessionId ?? ""}`;
  const scope = useRef(scopeOf(options));
  const currentScope = scopeOf(options);
  const typedContent = useRef(options.content);

  const abort = () => {
    const pending = request.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    request.current = null;
  };

  const start = () => {
    const input = latest.current;
    // A draft the user is already writing wins over any guess.
    if (!input.enabled || !input.sessionId || request.current) return;
    if (input.content.trim()) return;
    const controller = new AbortController();
    // An explicit timer (not AbortSignal.timeout) so the deadline is owned and
    // cancelled together with the request.
    const timer = setTimeout(
      () => controller.abort(),
      NEXT_INPUT_SUGGESTION_TIMEOUT_MS,
    );
    const startedScope = scope.current;
    request.current = { controller, timer };
    setHint(null);
    void suggestNextInput(
      {
        sessionId: input.sessionId,
        projectId: input.projectId,
        replySoFar: input.replyText
          ? input.replyText.slice(-MAX_REPLY_CONTEXT_CHARS)
          : undefined,
        model: input.model,
        backendId: input.backendId,
      },
      controller.signal,
    )
      .then((text) => {
        if (request.current?.controller !== controller) return;
        clearTimeout(timer);
        request.current = null;
        // A draft typed while the provider was thinking wins over the hint.
        if (!text || controller.signal.aborted) return;
        if (scope.current !== startedScope) return;
        if (latest.current.content.trim()) return;
        setHint({ scope: startedScope, text });
      })
      .catch(() => {
        // The hint is optional; a cancelled or failed call shows nothing.
      })
      .finally(() => {
        clearTimeout(timer);
        if (request.current?.controller === controller) request.current = null;
      });
  };

  const phase = useSessionLifecycle(currentScope, options.activity, (transition) => {
    if (transition === "reply_started") start();
    else if (
      // The step turned out to be tool work, or a new turn began: whatever the
      // previous turn produced is no longer a prediction of what comes next.
      transition === "reply_cancelled" ||
      transition === "turn_started"
    ) {
      abort();
      setHint(null);
    } else if (transition === "turn_settled") {
      if (latest.current.content.trim()) {
        abort();
        setHint(null);
      } else if (!hintRef.current && !request.current) {
        // Safety net for a phase signal this composer never saw.
        start();
      }
    }
  });

  useLayoutEffect(() => {
    if (scope.current !== currentScope) {
      // A different draft/session: nothing learned about the old one applies.
      scope.current = currentScope;
      typedContent.current = options.content;
      abort();
      setHint(null);
      return;
    }
    const typed =
      options.content !== typedContent.current && Boolean(options.content.trim());
    typedContent.current = options.content;
    if (!typed) return;
    // The user is writing their own message: drop the request and the hint.
    abort();
    setHint(null);
  });

  useLayoutEffect(() => () => abort(), []);

  const suggestion =
    phase === "settled" &&
    options.enabled &&
    !options.locked &&
    !options.content.trim() &&
    hint?.scope === currentScope
      ? hint.text
      : null;

  const accept = useCallback(() => {
    if (!suggestion) return;
    setHint(null);
    latest.current.onContentChange(suggestion);
  }, [suggestion]);

  return { suggestion, accept, phase };
}
