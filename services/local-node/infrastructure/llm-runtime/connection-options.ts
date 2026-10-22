import type { ProviderOptions } from "./contracts.js";

/** Retain namespaces used by saved custom-provider configuration. */
export function normalizeProviderOptionsNamespace(providerId: string): string {
  return providerId.split(".")[0]?.trim() || providerId;
}

/** Merge providerOptions layers (later wins per key). */
export function mergeProviderOptions(
  ...layers: Array<ProviderOptions | undefined>
): ProviderOptions {
  const merged: ProviderOptions = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [namespace, values] of Object.entries(layer)) {
      if (!values || typeof values !== 'object') continue
      merged[namespace] = {
        ...(merged[namespace] ?? {}),
        ...values,
      }
    }
  }
  return merged
}

