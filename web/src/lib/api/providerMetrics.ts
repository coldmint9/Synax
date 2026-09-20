import type { ApiFormat } from "../contracts/config";
import { apiFetch } from "./origin";

export interface ProviderMetricField {
  id: string;
  providerId: string;
  path: string;
  label: string;
  type: "number" | "string" | "boolean";
  unit?: string;
  source: "declared" | "observed";
  visible: boolean;
  accumulate: boolean;
  aggregation?: "sum" | "latest";
  lastValue?: number | string | boolean;
  total?: number;
  count: number;
  lastSeen?: string;
}

export interface ProviderMetricsScope {
  providerId?: string;
  sessionId?: string;
}

export interface ProviderMetricsDiscovery {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  format: ApiFormat;
}

const BASE = "/api/config/provider-metrics";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error || `Metrics request failed (${response.status})`,
    );
  return body as T;
}

export const providerMetricsApi = {
  list(scope: ProviderMetricsScope, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (scope.providerId) query.set("providerId", scope.providerId);
    if (scope.sessionId) query.set("sessionId", scope.sessionId);
    return request<{ fields: ProviderMetricField[] }>(`${BASE}?${query}`, {
      signal,
    });
  },

  update(
    id: string,
    patch: { visible?: boolean; accumulate?: boolean },
    scope: ProviderMetricsScope,
  ) {
    return request<{ fields: ProviderMetricField[] }>(BASE, {
      method: "PATCH",
      body: JSON.stringify({ id, ...patch, sessionId: scope.sessionId }),
    });
  },

  discover(payload: ProviderMetricsDiscovery, signal?: AbortSignal) {
    return request<{
      ok: boolean;
      supported: boolean;
      fields: ProviderMetricField[];
    }>(`${BASE}/discover`, {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });
  },
};

export const PROVIDER_METRICS_CHANGED = "synax:provider-metrics-changed";

export function notifyProviderMetricsChanged(providerId: string) {
  window.dispatchEvent(
    new CustomEvent(PROVIDER_METRICS_CHANGED, { detail: { providerId } }),
  );
}
