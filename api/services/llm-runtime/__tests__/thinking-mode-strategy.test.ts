import { describe, expect, it } from 'vitest'
import {
  buildThinkingStreamOptions,
  inferReasoningCapability,
  isDeepSeekHost,
  isDeepSeekSelection,
  mapThinkingModeToReasoningEffort,
  resolvePreferredProviderAdapter,
  resolveThinkingModeStrategy,
} from '../thinking-mode-strategy.js'
import type { ResolvedModelSelection } from '../types.js'

function deepSeekNativeSelection(): ResolvedModelSelection {
  return {
    providerId: 'custom-api:deepseek',
    modelId: 'deepseek-v4-flash',
    model: 'custom-api:deepseek/deepseek-v4-flash',
    provider: {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      npm: '@ai-sdk/deepseek',
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', reasoning: true },
    config: { providerId: 'custom-api:deepseek', baseUrl: 'https://api.deepseek.com' },
  }
}

function deepSeekCustomApiSelection(): ResolvedModelSelection {
  return {
    ...deepSeekNativeSelection(),
    provider: {
      ...deepSeekNativeSelection().provider,
      npm: '@ai-sdk/openai-compatible',
    },
  }
}

describe('thinking-mode-strategy', () => {
  it('resolves DeepSeek strategy for official API hosts', () => {
    expect(isDeepSeekHost('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekHost('https://api.openai.com/v1')).toBe(false)
    expect(resolveThinkingModeStrategy({
      providerId: 'custom-api:deepseek',
      baseUrl: 'https://api.deepseek.com',
    })?.id).toBe('deepseek')
  })

  it('enables native DeepSeek thinking via deepseek providerOptions', () => {
    expect(buildThinkingStreamOptions(deepSeekNativeSelection(), {})).toEqual({
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'high',
        },
      },
      temperature: undefined,
    })
  })

  it('enables custom-api DeepSeek thinking via provider id namespace (AI SDK v6)', () => {
    expect(buildThinkingStreamOptions(deepSeekCustomApiSelection(), { reasoningEffort: 'max' })).toEqual({
      providerOptions: {
        'custom-api:deepseek': {
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        },
        openaiCompatible: {
          reasoningEffort: 'max',
        },
      },
      temperature: undefined,
    })
  })

  it('maps Synax thinking mode to reasoning effort', () => {
    expect(mapThinkingModeToReasoningEffort('deep')).toBe('max')
    expect(mapThinkingModeToReasoningEffort('standard')).toBe('high')
  })

  it('prefers native SDK only for official DeepSeek API', () => {
    expect(resolvePreferredProviderAdapter({
      providerId: 'custom-api:deepseek',
      baseUrl: 'https://api.deepseek.com',
    })?.npm).toBe('@ai-sdk/deepseek')
    expect(resolvePreferredProviderAdapter({
      providerId: 'custom-api:deepseek',
      baseUrl: 'https://proxy.example.com/deepseek',
    })).toBeUndefined()
    expect(isDeepSeekSelection(deepSeekNativeSelection())).toBe(true)
    expect(inferReasoningCapability({
      providerId: 'custom-api:deepseek',
      baseUrl: 'https://api.deepseek.com',
    })).toBe(true)
  })

  it('passes through temperature for providers without a thinking strategy', () => {
    const selection = {
      ...deepSeekNativeSelection(),
      providerId: 'openai',
      provider: { ...deepSeekNativeSelection().provider, id: 'openai', npm: '@ai-sdk/openai' },
      config: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1' },
      modelDef: { id: 'gpt-4o', label: 'gpt-4o', reasoning: false },
    } satisfies ResolvedModelSelection

    expect(buildThinkingStreamOptions(selection, { temperature: 0.2 })).toEqual({
      temperature: 0.2,
    })
  })

  it('uses native reasoning strategy for catalog reasoning models', () => {
    expect(resolveThinkingModeStrategy({
      providerId: 'google',
      npm: '@ai-sdk/google',
      reasoning: true,
    })?.id).toBe('native-reasoning-model')
  })
})
