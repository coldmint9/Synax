import { describe, expect, it } from 'vitest'
import { isProviderSupported } from '../providers/provider-registry.js'

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
