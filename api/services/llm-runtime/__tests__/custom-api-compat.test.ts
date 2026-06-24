import { describe, expect, it } from 'vitest'
import {
  buildOpenAICompatibleClientSettings,
  buildOpenAICompatibleProviderOptions,
  normalizeProviderBaseUrl,
  resolveOpenAICompatibleProviderName,
  resolveProviderOptionsNamespace,
} from '../custom-api-compat.js'
import type { ResolvedModelSelection } from '../types.js'

describe('custom-api-compat', () => {
  it('normalizes provider base URLs without trailing slash', () => {
    expect(normalizeProviderBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
  })

  it('uses provider id as openai-compatible provider name', () => {
    expect(resolveOpenAICompatibleProviderName('custom-api:deepseek')).toBe('custom-api:deepseek')
  })

  it('builds AI SDK v6 openai-compatible client settings', () => {
    const settings = buildOpenAICompatibleClientSettings(
      { id: 'custom-api:deepseek', api: 'https://api.deepseek.com' },
      {
        providerId: 'custom-api:deepseek',
        baseUrl: 'https://api.deepseek.com/',
        apiKey: 'sk-test',
        options: { supportsStructuredOutputs: true },
      },
    )
    expect(settings).toEqual({
      name: 'custom-api:deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      includeUsage: true,
      supportsStructuredOutputs: true,
    })
  })

  it('resolves providerOptions namespace for custom-api vs native SDK', () => {
    const customSelection = {
      providerId: 'custom-api:deepseek',
      provider: { npm: '@ai-sdk/openai-compatible' },
    } as ResolvedModelSelection
    const nativeSelection = {
      providerId: 'deepseek',
      provider: { npm: '@ai-sdk/deepseek' },
    } as ResolvedModelSelection

    expect(resolveProviderOptionsNamespace(customSelection)).toBe('custom-api:deepseek')
    expect(resolveProviderOptionsNamespace(nativeSelection)).toBe('deepseek')
  })

  it('wraps custom body fields under provider namespace', () => {
    expect(buildOpenAICompatibleProviderOptions('custom-api:deepseek', {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })).toEqual({
      'custom-api:deepseek': {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      },
    })
  })
})
