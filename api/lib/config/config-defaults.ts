import type { GlobalConfig, ProviderDef } from './config-types.js'

const ACP_BASE_URL = 'http://127.0.0.1:3210'

function createBuiltinApiProvider(
  id: 'openai' | 'anthropic',
  label: string,
  description: string,
  defaultModel: string,
): ProviderDef {
  return {
    id,
    label,
    description,
    status: 'live',
    kind: 'api',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: defaultModel, label: defaultModel, isDefault: true }],
  }
}

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  {
    id: 'opencode-acp',
    label: 'OpenCode ACP',
    description: 'OpenCode Agent Client Protocol for local opencode runtime',
    status: 'live',
    kind: 'acp',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: 'opencode-default', label: 'OpenCode Default', isDefault: true }],
  },
  {
    id: 'cursor-acp',
    label: 'Cursor ACP',
    description: 'Cursor Agent Client Protocol for local Cursor runtime',
    status: 'live',
    kind: 'acp',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: 'cursor-default', label: 'Cursor Default', isDefault: true }],
  },
  createBuiltinApiProvider('openai', 'OpenAI', 'OpenAI-compatible API', 'gpt-4o-mini'),
  createBuiltinApiProvider('anthropic', 'Anthropic', 'Anthropic Messages API', 'claude-3-5-sonnet-latest'),
]

export function createDefaultGlobalConfig(updatedBy = 'system'): GlobalConfig {
  const now = new Date().toISOString()
  return {
    version: 1,
    providers: BUILTIN_PROVIDERS,
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: 'openai',
    enabledAcpProviderIds: ['opencode-acp'],
    providerConnections: {
      'opencode-acp': {
        providerId: 'opencode-acp',
        baseUrl: ACP_BASE_URL,
        extra: {
          kind: 'acp',
          connectionMode: 'local',
        },
      },
      'cursor-acp': {
        providerId: 'cursor-acp',
        baseUrl: ACP_BASE_URL,
        extra: {
          kind: 'acp',
          connectionMode: 'local',
        },
      },
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
    },
    limits: {
      maxAgentsPerProject: 10,
      agentTimeoutMs: 300_000,
    },
    features: {
      allowProjectConnectionOverride: true,
    },
    updatedAt: now,
    updatedBy,
  }
}

export function createDefaultUserGlobalConfig(updatedBy = 'system'): GlobalConfig {
  const now = new Date().toISOString()
  return {
    version: 1,
    providers: [],
    defaultProviderId: 'opencode-acp',
    defaultApiProviderId: 'openai',
    enabledAcpProviderIds: ['opencode-acp'],
    providerConnections: {},
    limits: {
      maxAgentsPerProject: 10,
      agentTimeoutMs: 300_000,
    },
    features: {
      allowProjectConnectionOverride: true,
    },
    updatedAt: now,
    updatedBy,
  }
}

export function convertAcpProviders(
  providers: Array<{ id: string; label: string; status: string; caps: { canFollowUp: boolean; canCancel: boolean }; description?: string }>,
): ProviderDef[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description,
    status: provider.status === 'experimental' ? 'experimental' : 'live',
    kind: 'acp',
    caps: provider.caps,
    models: [{ id: `${provider.id}-default`, label: `${provider.label} Default`, isDefault: true }],
  }))
}
