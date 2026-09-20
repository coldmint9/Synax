import { useCallback, useEffect, useRef, useState } from "react";
import {
  notifyProviderMetricsChanged,
  PROVIDER_METRICS_CHANGED,
  providerMetricsApi,
  type ProviderMetricField,
  type ProviderMetricsScope,
} from "../../../lib/api/providerMetrics";

export function useProviderMetrics(
  { providerId, sessionId }: ProviderMetricsScope,
  options: {
    enabled?: boolean;
    pollMs?: number;
    refreshKey?: string;
  } = {},
) {
  const { enabled = true, pollMs = 0, refreshKey } = options;
  const scopeKey = JSON.stringify([providerId, sessionId]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    key: string;
    fields: ProviderMetricField[];
    loading: boolean;
    error: string | null;
  }>({
    key: scopeKey,
    fields: [],
    loading: enabled,
    error: null,
  });
  const [pending, setPending] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!enabled) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const version = ++generation.current;
    setState((previous) =>
      previous.key === scopeKey
        ? { ...previous, loading: previous.fields.length === 0, error: null }
        : { key: scopeKey, fields: [], loading: true, error: null },
    );
    try {
      const result = await providerMetricsApi.list(
        { providerId, sessionId },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        version !== generation.current ||
        currentScope.current !== scopeKey
      )
        return;
      setState({
        key: scopeKey,
        fields: result.fields,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        version !== generation.current ||
        currentScope.current !== scopeKey
      )
        return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : "Metrics unavailable",
      }));
    }
  }, [enabled, providerId, sessionId, scopeKey]);

  useEffect(() => {
    void refresh();
    const timer =
      enabled && pollMs > 0
        ? window.setInterval(() => {
            void refresh();
          }, pollMs)
        : undefined;
    const onChange = (event: Event) => {
      const changed = (event as CustomEvent<{ providerId: string }>).detail
        ?.providerId;
      if (!providerId || providerId === changed) void refresh();
    };
    window.addEventListener(PROVIDER_METRICS_CHANGED, onChange);
    return () => {
      requestController.current?.abort();
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener(PROVIDER_METRICS_CHANGED, onChange);
    };
  }, [enabled, pollMs, providerId, refresh, refreshKey]);

  const update = useCallback(
    async (
      field: ProviderMetricField,
      patch: { visible?: boolean; accumulate?: boolean },
    ) => {
      setPending((previous) => new Set(previous).add(field.id));
      try {
        await providerMetricsApi.update(field.id, patch, {
          providerId,
          sessionId,
        });
        notifyProviderMetricsChanged(field.providerId);
      } catch (error) {
        if (currentScope.current === scopeKey)
          setState((previous) => ({
            ...previous,
            error:
              error instanceof Error
                ? error.message
                : "Could not save metrics settings",
          }));
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(field.id);
          return next;
        });
      }
    },
    [providerId, sessionId, scopeKey],
  );

  return {
    fields: state.key === scopeKey ? state.fields : [],
    loading: state.key === scopeKey ? state.loading : enabled,
    error: state.key === scopeKey ? state.error : null,
    pending,
    refresh,
    update,
  };
}
