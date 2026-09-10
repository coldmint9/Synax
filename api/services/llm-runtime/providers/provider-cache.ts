import type { ResolvedModelSelection, ResolvedProviderConfig, RuntimeProvider } from '../types.js'
import { instantiateProvider } from './provider-registry.js'

const clientCache = new Map<string, unknown>()

function cacheKey(selection: ResolvedModelSelection): string {
  const { providerId, config } = selection
  const keyPrefix = (config.apiKey ?? '').slice(0, 8)
  // The protocol decides which SDK client is constructed, so it must be part of the key:
  // otherwise switching a connection between chat completions and responses reuses a stale client.
  return `${providerId}:${selection.provider.npm ?? ''}:${selection.apiFormat}:${config.baseUrl ?? ''}:${keyPrefix}`
}

export async function getOrCreateClient(selection: ResolvedModelSelection): Promise<unknown> {
  const key = cacheKey(selection)
  const cached = clientCache.get(key)
  if (cached) return cached

  const client = await instantiateProvider(selection.provider, selection.config)
  clientCache.set(key, client)
  return client
}

export function invalidateClientCache(providerId?: string): void {
  if (!providerId) {
    clientCache.clear()
    return
  }
  for (const key of clientCache.keys()) {
    if (key.startsWith(`${providerId}:`)) clientCache.delete(key)
  }
}
