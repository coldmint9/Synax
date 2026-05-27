import type { ModelMessage, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { LlmGatewayRequest } from './types.js'

const JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION = 'Return only valid json that matches the requested schema.'

export function toModelPrompt(messages: LlmGatewayRequest['messages'], cacheControl?: boolean): { system?: string | SystemModelMessage[]; messages: ModelMessage[] } {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)

  const systemContent = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined

  let system: string | SystemModelMessage[] | undefined
  if (systemContent && cacheControl) {
    system = [{
      role: 'system',
      content: systemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    }]
  } else {
    system = systemContent
  }

  return {
    ...(system ? { system } : {}),
    messages: toModelMessages(messages.filter(isConversationMessage)),
  }
}

export function ensureJsonObjectResponseFormatInstruction(
  messages: LlmGatewayRequest['messages'],
): LlmGatewayRequest['messages'] {
  if (messages.some((message) => contentContainsLowercaseJson(message.content))) {
    return messages
  }

  const lastSystemIndex = messages.findLastIndex((message) => message.role === 'system')
  if (lastSystemIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== lastSystemIndex || message.role !== 'system') return message
      return {
        ...message,
        content: `${message.content.trim()}\n\n${JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION}`,
      }
    })
  }

  return [
    { role: 'system', content: JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION },
    ...messages,
  ]
}

function isConversationMessage(message: LlmGatewayRequest['messages'][number]): message is LlmGatewayRequest['messages'][number] & { role: 'user' | 'assistant' | 'tool' } {
  return message.role !== 'system'
}

function toModelMessages(messages: Array<LlmGatewayRequest['messages'][number] & { role: 'user' | 'assistant' | 'tool' }>): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content } satisfies ModelMessage
    }
    if (message.role === 'user') {
      return { role: 'user', content: message.content } satisfies ModelMessage
    }
    return { role: 'assistant', content: message.content } satisfies ModelMessage
  })
}

function contentContainsLowercaseJson(value: unknown): boolean {
  if (typeof value === 'string') return /\bjson\b/.test(value)
  if (Array.isArray(value)) return value.some((item) => contentContainsLowercaseJson(item))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => contentContainsLowercaseJson(item))
  }
  return false
}
