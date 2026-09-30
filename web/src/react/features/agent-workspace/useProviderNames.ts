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
 * Split `providerId/model` into the provider's display name and the bare model
 * id, e.g. `custom-api:1789630765113/glm-5.3` →
 * `{ provider: "智谱", model: "glm-5.3" }`. Unknown providers fall back to the
 * raw provider id; unprefixed references have no provider.
 */
export function splitProviderModel(
  model: string | null | undefined,
  providers: ProviderDef[],
): { provider: string | null; model: string | null } {
  const reference = model?.trim();
  if (!reference) return { provider: null, model: null };
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1)
    return { provider: null, model: reference };
  const providerId = reference.slice(0, separator);
  return {
    provider:
      providers.find((item) => item.id === providerId)?.label ?? providerId,
    model: reference.slice(separator + 1),
  };
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
  const reference = model?.trim();
  if (!reference) return null;
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return reference;
  const provider = providers.find(
    (item) => item.id === reference.slice(0, separator),
  );
  // Unknown providers keep the raw reference instead of a partial label.
  if (!provider?.label) return reference;
  return `${provider.label}/${reference.slice(separator + 1)}`;
}
