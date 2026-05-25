import { describe, expect, it } from 'vitest'
import { resolveLlmSelection } from '../resolver.js'
import type { RuntimeCatalog } from '../types.js'
import type { GlobalConfig, ProjectConfig } from '../../../lib/config/config-types.js'

const catalog: RuntimeCatalog = {
  fetchedAt: '2026-05-13T00:00:00.000Z',
  source: 'snapshot',
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      supported: true,
      env: ['OPENAI_API_KEY'],
      models: [
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini', isDefault: true },
        { id: 'gpt-4o', label: 'GPT-4o' },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      supported: true,
      env: ['ANTHROPIC_API_KEY'],
      models: [
        { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', isDefault: true },
        { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
      ],
    },
    {
      id: 'unsupported',
      label: 'Unsupported',
      supported: false,
      env: [],
      models: [{ id: 'default', label: 'Default', isDefault: true }],
    },
  ],
}

function createGlobalConfig(overrides?: Partial<GlobalConfig>): GlobalConfig {
  return {
    version: 1,
    providers: [
      {
        id: 'opencode-acp',
        label: 'OpenCode ACP',
        status: 'live',
        kind: 'acp',
        caps: { canFollowUp: true, canCancel: true },
        models: [{ id: 'opencode-default', label: 'OpenCode Default', isDefault: true }],
      },
      {
        id: 'openai',
        label: 'OpenAI',
        status: 'live',
        kind: 'api',
        caps: { canFollowUp: true, canCancel: true },
        models: [{ id: 'gpt-4o-mini', label: 'GPT-4o Mini', isDefault: true }],
      },
      {
        id: 'anthropic',
        label: 'Anthropic',
        status: 'live',
        kind: 'api',
        caps: { canFollowUp: true, canCancel: true },
        models: [{ id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', isDefault: true }],
      },
      {
        id: 'unsupported',
        label: 'Unsupported',
        status: 'live',
        kind: 'api',
        caps: { canFollowUp: true, canCancel: true },
        models: [{ id: 'default', label: 'Default', isDefault: true }],
      },
    ],
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: 'openai',
    enabledAcpProviderIds: ['opencode-acp'],
    providerConnections: {
      openai: {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        extra: {
          kind: 'api',
          apiFormat: 'openai',
          model: 'gpt-4o-mini',
        },
      },
      anthropic: {
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        extra: {
          kind: 'api',
          apiFormat: 'anthropic',
          model: 'claude-3-5-sonnet-latest',
        },
      },
      unsupported: {
        providerId: 'unsupported',
        baseUrl: 'https://unsupported.example/v1',
        extra: {
          kind: 'api',
          apiFormat: 'openai',
          model: 'default',
        },
      },
    },
    limits: {
      maxAgentsPerProject: 10,
      agentTimeoutMs: 300_000,
    },
    features: {
      allowProjectConnectionOverride: true,
    },
    updatedAt: '2026-05-13T00:00:00.000Z',
    updatedBy: 'tester',
    ...overrides,
  }
}

function createProjectConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    projectId: 'project-alpha',
    version: 1,
    updatedAt: '2026-05-13T00:00:00.000Z',
    updatedBy: 'tester',
    ...overrides,
  }
}

describe('resolveLlmSelection', () => {
  it('resolves a configured custom API provider even when it is absent from the runtime catalog', () => {
    const current = createGlobalConfig()
    const providerId = 'custom-api:rightcodes'
    const result = resolveLlmSelection({
      catalog,
      globalConfig: {
        ...current,
        providers: [
          ...current.providers,
          {
            id: providerId,
            label: 'RightCodes',
            status: 'live',
            kind: 'api',
            caps: { canFollowUp: true, canCancel: true },
            models: [{ id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', isDefault: true }],
          },
        ],
        defaultApiProviderId: providerId,
        providerConnections: {
          ...current.providerConnections,
          [providerId]: {
            providerId,
            baseUrl: 'https://www.right.codes/codex/v1',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-5.4-mini',
            },
          },
        },
      },
      purpose: 'wiki',
    })

    expect(result.providerId).toBe(providerId)
    expect(result.modelId).toBe('gpt-5.4-mini')
    expect(result.provider.npm).toBe('@ai-sdk/openai-compatible')
  })

  it('prefers project API provider/model override over global default', () => {
    const result = resolveLlmSelection({
      catalog,
      globalConfig: createGlobalConfig(),
      projectConfig: createProjectConfig({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
      }),
      purpose: 'wiki',
    })

    expect(result.providerId).toBe('anthropic')
    expect(result.modelId).toBe('claude-3-5-sonnet-latest')
  })

  it('supports plain model override by attaching preferred provider id', () => {
    const result = resolveLlmSelection({
      catalog,
      globalConfig: createGlobalConfig(),
      projectConfig: createProjectConfig({
        providerId: 'openai',
      }),
      purpose: 'context-signal',
      modelOverride: 'gpt-4o-mini',
      useSmallModel: true,
    })

    expect(result.model).toBe('openai/gpt-4o-mini')
  })

  it('falls back to the first enabled supported API provider when preferred one is unsupported', () => {
    const result = resolveLlmSelection({
      catalog,
      globalConfig: createGlobalConfig({ defaultApiProviderId: 'unsupported' }),
      purpose: 'wiki',
    })

    expect(result.providerId).toBe('openai')
    expect(result.modelId).toBe('gpt-4o-mini')
  })

  it('rejects models blocked by whitelist and falls back to a valid default model', () => {
    const result = resolveLlmSelection({
      catalog,
      globalConfig: createGlobalConfig({
        providerConnections: {
          openai: {
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'gpt-4o-mini',
              whitelist: ['gpt-4o-mini'],
            },
          },
          anthropic: {
            providerId: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            extra: {
              kind: 'api',
              apiFormat: 'anthropic',
              model: 'claude-3-5-sonnet-latest',
            },
          },
          unsupported: {
            providerId: 'unsupported',
            baseUrl: 'https://unsupported.example/v1',
            extra: {
              kind: 'api',
              apiFormat: 'openai',
              model: 'default',
            },
          },
        },
      }),
      projectConfig: createProjectConfig({
        providerId: 'openai',
        modelId: 'gpt-4o',
      }),
      purpose: 'wiki',
    })

    expect(result.model).toBe('openai/gpt-4o-mini')
  })
})
