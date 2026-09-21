import { useEffect, useState } from "react";
import { configApi } from "../../../lib/api/config";
import type { ProviderDef } from "../../../lib/contracts/config";

let cached: ProviderDef[] | null = null;
let inflight: Promise<ProviderDef[]> | null = null;

/** Shared provider catalog; display-only consumers dedupe through this cache. */
export function loadProviderNames(): Promise<ProviderDef[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = configApi
    .listProviders()
    .then((result) => {
      cached = result.providers;
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test helper — clear module memoization. */
export function resetProviderNamesCacheForTests(): void {
  cached = null;
  inflight = null;
}

export function useProviderNames(): ProviderDef[] {
  const [providers, setProviders] = useState<ProviderDef[]>(() => cached ?? []);
  useEffect(() => {
    let cancelled = false;
    void loadProviderNames()
      .then((items) => {
        if (!cancelled) setProviders(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}

/**
 * Render `providerId/model` with the provider's display name, e.g.
 * `custom-api:1789630765113/glm-5.3` → `智谱/glm-5.3`.
 * Falls back to the raw reference when the provider is unknown.
 */
export function formatModelDisplayName(
  model: string | null | undefined,
  providers: ProviderDef[],
): string | null {
  if (!model?.trim()) return null;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return model;
  const providerId = model.slice(0, separator);
  const provider = providers.find((item) => item.id === providerId);
  if (!provider?.label) return model;
  return `${provider.label}/${model.slice(separator + 1)}`;
}
