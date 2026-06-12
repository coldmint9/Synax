import { describe, expect, it } from 'vitest'
import { getStrategy } from '../providers/provider-strategy.js'

describe('getStrategy object mode', () => {
  it('enables structuredOutputs for openai-compatible providers (custom-api)', () => {
    const strategy = getStrategy('@ai-sdk/openai-compatible')
    expect(strategy.modelOptions({ kind: 'object' })).toEqual({ structuredOutputs: true })
    expect(strategy.modelOptions({ kind: 'text' })).toBeUndefined()
  })

  it('enables structuredOutputs for native openai and deepseek', () => {
    expect(getStrategy('@ai-sdk/openai').modelOptions({ kind: 'object' })).toEqual({ structuredOutputs: true })
    expect(getStrategy('@ai-sdk/deepseek').modelOptions({ kind: 'object' })).toEqual({ structuredOutputs: true })
  })

  it('does not set structuredOutputs for anthropic text/object (native API)', () => {
    expect(getStrategy('@ai-sdk/anthropic').modelOptions({ kind: 'object' })).toBeUndefined()
  })
})
