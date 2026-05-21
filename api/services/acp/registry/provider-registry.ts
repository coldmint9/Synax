// ---------------------------------------------------------------------------
// AcpProvider registry
//
// Static in-process registry of ACP provider implementations. Providers are
// registered at module-load time from api/services/acp/index.ts, but external
// code may also call registerProvider() to inject custom providers before
// createAcpClient() is invoked.
// ---------------------------------------------------------------------------

import { logger } from '../../../lib/logger.js'
import type { AcpClient } from '../contracts.js'

/** Lifecycle status — informational only; does not gate selection. */
export type AcpProviderStatus = 'live' | 'experimental'

export interface AcpProviderCaps {
  canFollowUp: boolean
  canCancel: boolean
}

/**
 * An AcpProvider is a pluggable Agent backend. The factory `createClient()`
 * is invoked per-dispatch so each run gets an isolated client instance
 * (important: subprocess state must not leak across runs).
 */
export interface AcpProvider {
  id: string
  label: string
  description?: string
  status: AcpProviderStatus
  caps: AcpProviderCaps
  createClient(): AcpClient
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const _registry = new Map<string, AcpProvider>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Register a provider. Overwriting an existing id emits a warning. */
export function registerProvider(provider: AcpProvider): void {
  if (_registry.has(provider.id)) {
    logger.warn(
      { id: provider.id },
      '[AcpRegistry] overwriting existing provider',
    )
  }
  _registry.set(provider.id, provider)
  logger.info(
    { id: provider.id, label: provider.label, status: provider.status },
    '[AcpRegistry] provider registered',
  )
}

/** Lookup a provider by id. Returns undefined if not registered. */
export function getProvider(id: string): AcpProvider | undefined {
  return _registry.get(id)
}

/** Enumerate all registered providers (stable insertion order). */
export function listProviders(): AcpProvider[] {
  return Array.from(_registry.values())
}

/** Remove a provider. Returns true if one was removed. */
export function unregisterProvider(id: string): boolean {
  return _registry.delete(id)
}

/** Convenience: check whether a given id is registered. */
export function hasProvider(id: string): boolean {
  return _registry.has(id)
}
