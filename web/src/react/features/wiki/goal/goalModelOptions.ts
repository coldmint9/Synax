import type { AcpDiscoveryItem, GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'
import { buildApiDrafts, isConfiguredProvider } from '../../settings/lib/providerPresets'

export type GoalModelSelection = {
  kind: 'api' | 'acp'
  providerId: string
  modelId: string
  label: string
}

export function selectionKey(sel: Pick<GoalModelSelection, 'kind' | 'providerId' | 'modelId'>): string {
  return `${sel.kind}:${sel.providerId}:${sel.modelId}`
}

const ACP_PROVIDER_IDS = new Set(['cursor-acp', 'opencode-acp'])

/** Turn API expects `providerId/modelId` for ACP engines; API models keep bare modelId. */
export function formatTurnModel(providerId: string | null, modelId: string | null): string | undefined {
  if (!modelId?.trim()) return undefined
  if (providerId && ACP_PROVIDER_IDS.has(providerId)) {
    return `${providerId}/${modelId.trim()}`
  }
  return modelId.trim()
}

function isAcpEndpointAvailable(
  provider: ProviderDef,
  discovery: AcpDiscoveryItem | undefined,
): boolean {
  if (provider.status === 'inactive') return false
  if (!discovery) return true
  if (discovery.status === 'missing') return false
  return discovery.handshakeOk
}

export function buildGoalModelOptions(
  globalConfig: GlobalConfig | null,
  providers: ProviderDef[],
  acpDiscovery: AcpDiscoveryItem[] = [],
): { apiModels: GoalModelSelection[]; acpEndpoints: GoalModelSelection[] } {
  const apiModels: GoalModelSelection[] = []
  const acpEndpoints: GoalModelSelection[] = []

  if (globalConfig) {
    const drafts = buildApiDrafts(globalConfig, providers).filter(isConfiguredProvider)
    for (const draft of drafts) {
      for (const modelId of draft.models) {
        apiModels.push({
          kind: 'api',
          providerId: draft.id,
          modelId,
          label: modelId,
        })
      }
    }
  }

  const enabledAcp = new Set(globalConfig?.enabledAcpProviderIds ?? [])
  const discoveryById = new Map(acpDiscovery.map(item => [item.id, item]))

  for (const provider of providers) {
    if (provider.kind !== 'acp' || !enabledAcp.has(provider.id)) continue
    const discoveryItem = discoveryById.get(provider.id)
    if (!isAcpEndpointAvailable(provider, discoveryItem)) {
      continue
    }
    const modelId = provider.models.find(m => m.isDefault)?.id
      ?? provider.models[0]?.id
      ?? provider.id
    acpEndpoints.push({
      kind: 'acp',
      providerId: provider.id,
      modelId,
      label: provider.label,
    })
  }

  return { apiModels, acpEndpoints }
}

export function findGoalModelSelection(
  apiModels: GoalModelSelection[],
  acpEndpoints: GoalModelSelection[],
  providerId: string | null,
  modelId: string | null,
): GoalModelSelection | null {
  if (!providerId || !modelId) return null
  return (
    apiModels.find(m => m.providerId === providerId && m.modelId === modelId)
    ?? acpEndpoints.find(m => m.providerId === providerId && m.modelId === modelId)
    ?? null
  )
}

export function pickDefaultSelection(
  apiModels: GoalModelSelection[],
  acpEndpoints: GoalModelSelection[],
  preferred?: { providerId: string; modelId: string } | null,
): GoalModelSelection | null {
  if (preferred) {
    const found = findGoalModelSelection(apiModels, acpEndpoints, preferred.providerId, preferred.modelId)
    if (found) return found
  }
  return apiModels[0] ?? acpEndpoints[0] ?? null
}
