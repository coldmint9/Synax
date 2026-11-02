import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionSearchResponse,
} from "../../adapters/transport/agentRuntime";
import { AppError } from "../../shared/lib/appError";

type SearchState = {
  key: string;
  items: SessionSearchResponse["items"];
  hasMore: boolean;
  terms: string[];
  indexing: SessionSearchResponse["indexing"] | null;
  loading: boolean;
  offset: number;
  error: string | null;
};
const empty: SearchState = {
  key: "",
  items: [],
  hasMore: false,
  terms: [],
  indexing: null,
  loading: false,
  offset: 0,
  error: null,
};

const RETRY_DELAYS_MS = [120, 360] as const;
/** Transcripts are indexed in the background; refresh until the backlog drains. */
const INDEX_REFRESH_DELAY_MS = 700;
const MAX_INDEX_REFRESHES = 8;
/** Two polls without progress mean the remaining sessions are not queued now. */
const MAX_STAGNANT_REFRESHES = 2;

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
    // A revalidation of the same query keeps the rows on screen instead of
    // flashing a skeleton, so typing and index refreshes never blink the list.
    setState((previous) =>
      previous.key === key && enabled
        ? { ...previous, loading: true, error: null }
        : { ...empty, key, loading: enabled },
    );
    if (!enabled) return () => request.abort();
    const timer = setTimeout(async () => {
      const commit = (result: SessionSearchResponse) => {
        if (request.signal.aborted) return;
        setState({
          items: result.items,
          hasMore: result.hasMore,
          terms: result.terms ?? [q],
          indexing: result.indexing ?? null,
          key,
          offset: result.items.length,
          loading: false,
          error: null,
        });
      };
      try {
        let result = await searchWithRetry(projectId, q, 0, request.signal);
        commit(result);
        // The first search answers from the session projection while the
        // transcripts are indexed. Follow the backlog so content hits appear
        // without the user retyping, and stop as soon as it stops shrinking.
        let stagnant = 0;
        let backlog = result.indexing?.pending ?? 0;
        for (let poll = 0; poll < MAX_INDEX_REFRESHES && backlog > 0; poll += 1) {
          await waitForRetry(INDEX_REFRESH_DELAY_MS, request.signal);
          result = await searchWithRetry(projectId, q, 0, request.signal);
          commit(result);
          const next = result.indexing?.pending ?? 0;
          stagnant = next >= backlog ? stagnant + 1 : 0;
          backlog = next;
          if (stagnant >= MAX_STAGNANT_REFRESHES) break;
        }
      } catch (error) {
        if (!request.signal.aborted)
          setState({
            ...empty,
            key,
            terms: [q],
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
    ...(state.key === key ? state : { ...empty, loading: enabled, terms: [q] }),
    enabled,
    query: q,
    loadMore,
    refresh,
  };
}
