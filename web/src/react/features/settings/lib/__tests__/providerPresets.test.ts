import { describe, expect, it } from 'vitest'
import type { GlobalConfig, ProviderDef } from '../../../../../lib/contracts/config'
import {
  API_FORMAT_OPTIONS,
  API_PROVIDER_PRESETS,
  apiFormatLabel,
  applyProtocolDefaults,
  buildApiDrafts,
  createDraftFromPreset,
  draftToConnection,
  draftToProviderDef,
  effectiveReasoningEfforts,
  providerReasoningEfforts,
  upsertDraft,
  type ApiProviderDraft,
} from '../providerPresets'

function makeProvider(): ProviderDef {
  return {
    id: 'custom-api:deepseek',
    label: 'DeepSeek',
    status: 'live',
    kind: 'api',
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat', isDefault: true, contextLimit: 1_000_000 },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ],
  }
}

function makeConfig(provider: ProviderDef, extra?: Record<string, unknown>): GlobalConfig {
  return {
    version: 1,
    providers: [provider],
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: provider.id,
    enabledAcpProviderIds: ['opencode-acp'],
    providerConnections: {
      [provider.id]: {
        providerId: provider.id,
        baseUrl: 'https://api.deepseek.com',
        apiKeyMasked: 'sk-****',
        extra: {
          kind: 'api',
          apiFormat: 'openai',
          model: 'deepseek-chat',
          ...extra,
        },
      },
    },
    mcpServers: [],
    limits: { maxAgentsPerProject: 10, agentTimeoutMs: 300_000 },
    features: { allowProjectConnectionOverride: true },
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
  }
}

describe('providerPresets model metadata', () => {
  it('round-trips model contextLimit and allowed reasoning efforts', () => {
    const provider = makeProvider()
    const config = makeConfig(provider, { reasoningEfforts: ['high', 'max'] })
    const drafts = buildApiDrafts(config, [provider])
    const draft = drafts.find(d => d.id === provider.id)
    expect(draft).toBeDefined()
    expect(draft!.modelMeta['deepseek-chat']?.contextLimit).toBe(1_000_000)
    expect(draft!.reasoningEfforts).toEqual(['high', 'max'])

    const def = draftToProviderDef(draft!)
    const connection = draftToConnection(draft!)
    expect(def.models.find(m => m.id === 'deepseek-chat')?.contextLimit).toBe(1_000_000)
    expect(connection.extra?.reasoningEfforts).toEqual(['high', 'max'])
    expect(connection.extra?.model).toBe('deepseek-chat')
  })

  it('falls back to a legacy single default effort and to all levels when unrestricted', () => {
    const provider = makeProvider()
    const config = makeConfig(provider, { defaultReasoningEffort: 'high' })
    expect(providerReasoningEfforts(config, provider.id)).toEqual(['high'])
    expect(effectiveReasoningEfforts(config, provider.id)).toEqual(['high'])

    const unrestricted = makeConfig(provider, {})
    expect(providerReasoningEfforts(unrestricted, provider.id)).toEqual([])
    expect(effectiveReasoningEfforts(unrestricted, provider.id)).toHaveLength(5)
  })

  it('upsertDraft preserves metadata when only the model changes', () => {
    const provider = makeProvider()
    const config = makeConfig(provider, { reasoningEfforts: ['medium', 'high'] })
    const drafts = buildApiDrafts(config, [provider])
    const draft = drafts.find(d => d.id === provider.id)!
    const next: ApiProviderDraft = { ...draft, model: 'deepseek-reasoner', modelMeta: {} }
    const merged = upsertDraft(drafts, next)
    const saved = merged.find(d => d.id === provider.id)!
    expect(saved.model).toBe('deepseek-reasoner')
    expect(saved.modelMeta['deepseek-chat']?.contextLimit).toBe(1_000_000)
    expect(saved.reasoningEfforts).toEqual(['medium', 'high'])
  })
})

describe('provider protocol selection', () => {
  it('offers exactly the three supported protocols', () => {
    expect(API_FORMAT_OPTIONS.map(option => option.key)).toEqual([
      'openai',
      'openai-responses',
      'anthropic',
    ])
    expect(apiFormatLabel('openai-responses')).toBe('OpenAI Responses')
    expect(apiFormatLabel('anthropic')).toBe('Anthropic Messages')
  })

  it('switches untouched defaults to the new protocol and keeps edited values', () => {
    const preset = API_PROVIDER_PRESETS.find(p => p.providerId === 'openai')!
    const draft = createDraftFromPreset(preset)

    const untouched = applyProtocolDefaults(draft, 'anthropic')
    expect(untouched.format).toBe('anthropic')
    expect(untouched.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(untouched.model).toBe('claude-3-5-sonnet-latest')

    const responses = applyProtocolDefaults(draft, 'openai-responses')
    expect(responses.format).toBe('openai-responses')
    expect(responses.baseUrl).toBe('https://api.openai.com/v1')
    expect(responses.model).toBe('gpt-4o-mini')

    const edited = applyProtocolDefaults(
      { ...draft, model: 'gpt-5.4-codex', baseUrl: 'https://xuanji.example.com/v1' },
      'openai-responses',
    )
    expect(edited.format).toBe('openai-responses')
    expect(edited.baseUrl).toBe('https://xuanji.example.com/v1')
    expect(edited.model).toBe('gpt-5.4-codex')

    const provider = makeProvider()
    const customDraft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(d => d.id === provider.id)!
    expect(applyProtocolDefaults(customDraft, 'anthropic').model).toBe('deepseek-chat')
  })

  it('persists the selected protocol in the connection extra', () => {
    const provider = makeProvider()
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(d => d.id === provider.id)!
    const connection = draftToConnection({ ...draft, format: 'openai-responses' })
    expect(connection.extra?.apiFormat).toBe('openai-responses')
  })
})
