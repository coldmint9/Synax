import type { GlobalConfig } from './config-types.js'

/** Keep stable connection IDs so existing sessions and project overrides keep working. */
export function normalizeLegacyProviders(config: GlobalConfig): GlobalConfig {
  let changed = false
  const providers = config.providers.map(provider => {
    if (provider.id !== 'openai' || provider.label.toLowerCase() !== 'openai') return provider
    const baseUrl = config.providerConnections[provider.id]?.baseUrl
    if (!baseUrl) return provider
    try {
      if (!new URL(baseUrl).hostname.split('.').includes('xuanji')) return provider
    } catch {
      return provider
    }
    changed = true
    return { ...provider, label: 'xuanji' }
  })
  return changed ? { ...config, providers } : config
}
