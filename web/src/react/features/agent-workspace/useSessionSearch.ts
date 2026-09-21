import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionSearchResponse,
} from "../../../lib/api/agentRuntime";
import { AppError } from "../../../lib/appError";

type SearchState = SessionSearchResponse & {
  key: string;
  loading: boolean;
  offset: number;
  error: string | null;
};
const empty: SearchState = {
  key: "",
  items: [],
  hasMore: false,
  loading: false,
  offset: 0,
  error: null,
};

const RETRY_DELAYS_MS = [120, 360] as const;

function isTransientServerError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.statusCode !== undefined &&
    error.statusCode >= 500
  );
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function searchWithRetry(
  projectId: string,
  query: string,
  offset: number,
  signal: AbortSignal,
): Promise<SessionSearchResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await agentRuntimeApi.searchSessions(
        projectId,
        query,
        offset,
        signal,
      );
    } catch (error) {
      if (
        signal.aborted ||
        !isTransientServerError(error) ||
        attempt >= RETRY_DELAYS_MS.length
      )
        throw error;
      await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

export function useSessionSearch(projectId: string, query: string) {
  const q = query.trim();
  const key = JSON.stringify([projectId, q]);
  const enabled = Boolean(projectId && q);
  const [state, setState] = useState<SearchState>(empty);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    pending.current = false;
    setState({ ...empty, key, loading: enabled });
    if (!enabled) return () => request.abort();
    const timer = setTimeout(async () => {
      try {
        const result = await searchWithRetry(projectId, q, 0, request.signal);
        if (!request.signal.aborted)
          setState({
            ...result,
            key,
            offset: result.items.length,
            loading: false,
            error: null,
          });
      } catch (error) {
        if (!request.signal.aborted)
          setState({
            ...empty,
            key,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [enabled, key, projectId, q, revision]);

  const loadMore = useCallback(async () => {
    const request = controller.current;
    if (
      !enabled ||
      state.key !== key ||
      !state.hasMore ||
      state.loading ||
      pending.current ||
      !request ||
      request.signal.aborted
    )
      return;
    pending.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await searchWithRetry(
        projectId,
        q,
        state.offset,
        request.signal,
      );
      if (!request.signal.aborted)
        setState((s) => ({
          ...s,
          items: [
            ...s.items,
            ...result.items.filter(
              (item) =>
                !s.items.some((old) => old.session.id === item.session.id),
            ),
          ],
          hasMore: result.hasMore,
          offset: s.offset + result.items.length,
          loading: false,
        }));
    } catch (error) {
      if (!request.signal.aborted)
        setState((s) => ({
          ...s,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (!request.signal.aborted) pending.current = false;
    }
  }, [enabled, state, key, projectId, q]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    ...(state.key === key ? state : { ...empty, loading: enabled }),
    enabled,
    query: q,
    loadMore,
    refresh,
  };
}
