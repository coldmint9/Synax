import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionSearchResponse,
} from "../../../lib/api/agentRuntime";

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
        const result = await agentRuntimeApi.searchSessions(
          projectId,
          q,
          0,
          request.signal,
        );
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
      const result = await agentRuntimeApi.searchSessions(
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
