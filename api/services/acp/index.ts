// ---------------------------------------------------------------------------
// ACP public entry
//
// Registers built-in providers at module load and exposes:
//   - createAcpClient()        (default factory, preserved for callers)
//   - createAcpClientFor(id)   (explicit provider selection)
//   - registerProvider() / getProvider() / listProviders()  (extension hooks)
// ---------------------------------------------------------------------------

import { logger } from '../../lib/logger.js'
import { getEffectiveConfig } from '../../lib/config/config-store.js'
import type { AcpClient } from './contracts.js'
import { cursorAcpProvider } from './providers/cursor-acp-provider.js'
import { openCodeAcpProvider } from './providers/opencode-acp-provider.js'
import {
  getProvider,
  hasProvider,
  listProviders,
  registerProvider,
  unregisterProvider,
} from './registry/provider-registry.js'

// --- Re-exports (business types + extension API) ---
export type { AcpClient } from './contracts.js'
export type {
  CoordinatesRunEvent,
  CoordinatesRunEventType,
  DispatchIntentInput,
  DispatchIntentResult,
  ProviderId,
} from './contracts.js'
export {
  getProvider,
  hasProvider,
  listProviders,
  registerProvider,
  unregisterProvider,
}
export type {
  AcpProvider,
  AcpProviderCaps,
  AcpProviderStatus,
} from './registry/provider-registry.js'

// ---------------------------------------------------------------------------
// Register built-in providers (idempotent on re-import)
// ---------------------------------------------------------------------------

if (!hasProvider(openCodeAcpProvider.id)) registerProvider(openCodeAcpProvider)
if (!hasProvider(cursorAcpProvider.id)) registerProvider(cursorAcpProvider)

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Instantiate the provider explicitly requested by id. Throws if unknown.
 */
export async function createAcpClientFor(providerId: string): Promise<AcpClient> {
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error(
      `ACP provider not found: ${providerId}. Registered: ${listProviders().map((p) => p.id).join(', ')}`,
    )
  }
  logger.info(
    { providerId, label: provider.label, status: provider.status },
    '[ACP] using provider',
  )
  return provider.createClient()
}

/**
 * Default factory for callers without project context.
 * Preserved for callers (e.g. api/routes/coordinates.ts) that haven't
 * adopted explicit provider selection yet.
 */
export async function createAcpClient(): Promise<AcpClient> {
  return createAcpClientFor('opencode-acp')
}

// ---------------------------------------------------------------------------
// Config-driven factory (NEW — preferred path)
// ---------------------------------------------------------------------------

/**
 * Create an ACP client based on the project's effective configuration.
 *
 * Resolution order:
 *   1. ProjectConfig.providerId  →  explicit project override
 *   2. GlobalConfig.defaultProviderId  →  system default
 *
 * This is the preferred path for all callers that have a project context.
 * Callers without a project context (e.g. health checks) should use
 * createAcpClient() (default provider compatibility).
 */
export async function createAcpClientForProject(projectId: string): Promise<AcpClient> {
  const effective = getEffectiveConfig(projectId)
  const resolvedProviderId = hasProvider(effective.providerId)
    ? effective.providerId
    : 'opencode-acp'
  if (resolvedProviderId !== effective.providerId) {
    logger.warn(
      { projectId, providerId: effective.providerId, fallbackProviderId: resolvedProviderId },
      '[ACP] config provider is not an ACP provider; falling back',
    )
  } else {
    logger.info({ projectId, providerId: resolvedProviderId }, '[ACP] using config-driven provider')
  }
  return createAcpClientFor(resolvedProviderId)
}
