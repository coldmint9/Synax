import { describe, expect, it } from 'vitest'
import { ensureJsonObjectResponseFormatInstruction } from '../prompt.js'
import type { LlmGatewayRequest } from '../types.js'

describe('ensureJsonObjectResponseFormatInstruction', () => {
  it('adds a lowercase json instruction for json_object-compatible providers', () => {
    const messages: LlmGatewayRequest['messages'] = [
      { role: 'system', content: 'Output valid JSON matching the schema exactly.' },
      { role: 'user', content: 'Generate a structured response.' },
    ]

    const result = ensureJsonObjectResponseFormatInstruction(messages)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('Return only valid json'),
    })
    expect(result[1]).toBe(messages[1])
  })

  it('does not change prompts that already contain lowercase json', () => {
    const messages: LlmGatewayRequest['messages'] = [
      { role: 'user', content: 'Return valid json for this task.' },
    ]

    expect(ensureJsonObjectResponseFormatInstruction(messages)).toBe(messages)
  })

  it('creates a system instruction when the request has no system message', () => {
    const messages: LlmGatewayRequest['messages'] = [
      { role: 'user', content: 'Generate a structured response.' },
    ]

    const result = ensureJsonObjectResponseFormatInstruction(messages)

    expect(result[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('valid json'),
    })
    expect(result[1]).toBe(messages[0])
  })
})
