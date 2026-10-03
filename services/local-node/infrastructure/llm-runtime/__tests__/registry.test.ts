import { describe, expect, it, vi } from 'vitest'
import { isProviderSupported, selectLanguageModel } from '../providers/provider-registry.js'

describe('llm provider registry', () => {
  it('accepts allowlisted AI SDK providers', () => {
    expect(isProviderSupported({ npm: '@ai-sdk/openai' })).toBe(true)
    expect(isProviderSupported({ npm: '@ai-sdk/openai-compatible' })).toBe(true)
  })

  it('rejects unknown providers instead of falling back to custom adapters', () => {
    expect(isProviderSupported({ npm: '@acme/custom-runtime' })).toBe(false)
    expect(isProviderSupported({ npm: undefined })).toBe(false)
  })
})

describe('selectLanguageModel protocol routing', () => {
  function createNativeClient() {
    const responses = vi.fn(() => 'responses-model')
    const chat = vi.fn(() => 'chat-model')
    const messages = vi.fn(() => 'messages-model')
    const client = Object.assign(vi.fn(() => 'callable-model'), { responses, chat, messages })
    return { client, responses, chat, messages }
  }

  it('pins each protocol to its API surface', () => {
    const { client, responses, chat, messages } = createNativeClient()

    expect(selectLanguageModel(client, 'gpt-5.4-codex', undefined, 'openai-responses')).toBe('responses-model')
    expect(responses).toHaveBeenCalledWith('gpt-5.4-codex', undefined)

    expect(selectLanguageModel(client, 'gpt-4o-mini', undefined, 'openai')).toBe('chat-model')
    expect(chat).toHaveBeenCalledWith('gpt-4o-mini', undefined)

    expect(selectLanguageModel(client, 'claude-sonnet-4-6', undefined, 'anthropic')).toBe('messages-model')
    expect(messages).toHaveBeenCalledWith('claude-sonnet-4-6', undefined)
  })

  it('keeps openai-compatible clients callable instead of requiring an API surface', () => {
    const client = vi.fn(() => 'compat-model')

    expect(selectLanguageModel(client, 'deepseek-v4-flash', undefined, 'openai')).toBe('compat-model')
  })

  it('keeps the historical selector order when no protocol is given', () => {
    const { client } = createNativeClient()

    expect(selectLanguageModel(client, 'gpt-5')).toBe('callable-model')
  })
})
