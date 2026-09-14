import { describe, expect, it } from 'vitest'
import type { GlobalConfig, ProviderDef } from '../../../../../lib/contracts/config'
import {
  API_FORMAT_OPTIONS,
  API_PROVIDER_PRESETS,
  apiFormatLabel,
  applyProtocolDefaults,
  buildApiDrafts,
  configuredModelList,
  createDraftFromPreset,
  draftToConnection,
  draftToProviderDef,
  effectiveReasoningEfforts,
  mergeModelOptions,
  providerReasoningEfforts,
  selectDefaultModel,
  toggleModelSelection,
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

  it('keeps discovered models as picker candidates until they are selected', () => {
    const provider = makeProvider()
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(d => d.id === provider.id)!
    expect(draft.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(draft.modelOptions).toEqual(['deepseek-chat', 'deepseek-reasoner'])

    // 发现回来的模型只进入候选池，不会自动变成已配置模型
    const widened = { ...draft, modelOptions: mergeModelOptions(['gpt-4o', 'gpt-4.1'], draft.modelOptions) }
    expect(widened.modelOptions).toEqual(['gpt-4o', 'gpt-4.1', 'deepseek-chat', 'deepseek-reasoner'])
    expect(configuredModelList(widened)).toEqual(['deepseek-chat', 'deepseek-reasoner'])

    const selected = toggleModelSelection(widened, 'gpt-4o')
    expect(configuredModelList(selected)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'gpt-4o'])

    const deselected = toggleModelSelection(selected, 'gpt-4o')
    expect(configuredModelList(deselected)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('keeps the default model configured and promotes a new default', () => {
    const provider = makeProvider()
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(d => d.id === provider.id)!
    const promoted = selectDefaultModel(toggleModelSelection(draft, 'gpt-4o'), 'gpt-4o')

    expect(promoted.model).toBe('gpt-4o')
    expect(promoted.models).toEqual(['deepseek-chat', 'deepseek-reasoner', 'gpt-4o'])
    // 默认模型不能被取消勾选，非默认模型可以
    expect(toggleModelSelection(promoted, 'gpt-4o')).toBe(promoted)
    expect(configuredModelList(toggleModelSelection(promoted, 'deepseek-chat')))
      .toEqual(['deepseek-reasoner', 'gpt-4o'])
  })

  it('persists only the selected models for the provider', () => {
    const provider = makeProvider()
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(d => d.id === provider.id)!
    // 仅出现在候选池里的模型不会被保存
    const withCandidate = { ...draft, modelOptions: mergeModelOptions(draft.modelOptions, ['gpt-4o']) }
    expect(withCandidate.modelOptions).toContain('gpt-4o')
    expect(draftToProviderDef(withCandidate).models.map(m => m.id))
      .toEqual(['deepseek-chat', 'deepseek-reasoner'])

    // 勾选后才写入 provider 定义
    expect(draftToProviderDef(toggleModelSelection(withCandidate, 'gpt-4o')).models.map(m => m.id))
      .toEqual(['deepseek-chat', 'deepseek-reasoner', 'gpt-4o'])
  })
})
