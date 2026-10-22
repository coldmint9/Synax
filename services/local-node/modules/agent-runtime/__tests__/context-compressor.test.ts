import { describe, expect, it, vi } from 'vitest'
import { compactMessages, getCompactionConfig, serializeMessagesForSummary, shouldCompact } from '../context-compressor.js'

describe('context compaction threshold', () => {
  it('does not compact below the default 200K window at 150K tokens', () => {
    expect(shouldCompact(150_000, 200_000, getCompactionConfig())).toBe(false)
  })

  it('compacts above the default 200K window', () => {
    expect(shouldCompact(200_001, 200_000, getCompactionConfig())).toBe(true)
  })

  it('defers compaction for a 1M input-context model well past 200K', () => {
    // 1M-context model (threshold 0.92) should not compact at 300K tokens…
    expect(shouldCompact(300_000, 1_000_000, getCompactionConfig())).toBe(false)
    // …and only compact once total tokens exceed 920K.
    expect(shouldCompact(921_000, 1_000_000, getCompactionConfig())).toBe(true)
  })

  it('respects disabled compaction', () => {
    expect(shouldCompact(5_000_000, 1_000_000, getCompactionConfig({ enabled: false }))).toBe(false)
  })
})

describe('attachments are excluded from compaction', () => {
  const user = { role: 'user', content: [
    { type: 'text', text: 'Original attachment instructions' },
    { type: 'image', image: 'USER_IMAGE_SECRET' },
    { type: 'file', data: new Uint8Array([137, 80, 78, 71]), filename: 'report.pdf' },
  ] }
  const calls = { role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 'media', toolName: 'media_read', input: {} },
    { type: 'tool-call', toolCallId: 'sibling', toolName: 'file_read', input: {} },
  ] }
  const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'media', toolName: 'media_read',
    output: { type: 'content', value: [
      { type: 'text', text: 'Media description' },
      { type: 'image', image: 'TOOL_IMAGE_SECRET' },
    ] },
  }] }
  const sibling = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'sibling', toolName: 'file_read',
    output: { type: 'text', value: 'Sibling evidence' },
  }] }
  const native = { role: 'assistant', content: [{ type: 'text', text: 'Generated media' }],
    rigMessage: { content: [{ type: 'document', data: 'NATIVE_DOCUMENT_SECRET' }] },
  }

  it('keeps media and full tool exchanges while summarizing ordinary history', async () => {
    const recent = [{ role: 'user', content: 'Continue' }, { role: 'assistant', content: 'Checking' }]
    const messages = [user, { role: 'assistant', content: 'Earlier textual evidence' }, calls, result, sibling, native, ...recent]
    const original = structuredClone(messages)
    const generateSummary = vi.fn().mockResolvedValue('Earlier textual evidence, summarized.')
    const compacted = await compactMessages(messages, {
      sessionId: 'media-test', runId: null, contextLimit: 1000,
      config: { preserveRecentMessages: 2 }, generateSummary,
    })
    expect(generateSummary).toHaveBeenCalledOnce()
    expect(generateSummary.mock.calls[0][1]).toBe('Summarize this conversation:\n\n[ASSISTANT]: Earlier textual evidence')
    expect(compacted.messages.slice(0, 5)).toEqual([user, calls, result, sibling, native])
    expect(compacted.messages.slice(-2)).toEqual(recent)
    expect(compacted.record?.compressedMessageCount).toBe(1)
    expect(messages).toEqual(original)
  })

  it('uses the same attachment boundary for manual summary serialization', () => {
    const text = serializeMessagesForSummary([
      user, calls, result, sibling, native,
      { role: 'assistant', content: [{ type: 'text', text: 'Safe text' }] },
    ])
    expect(text).toBe('[ASSISTANT]: Safe text')
  })

  it('skips summary calls when only protected media history is available', async () => {
    const messages = [user, calls, result, sibling, native, { role: 'user', content: 'Continue' }]
    const generateSummary = vi.fn()
    const compacted = await compactMessages(messages, {
      sessionId: 'media-only', runId: null, contextLimit: 1000,
      config: { preserveRecentMessages: 1 }, generateSummary,
    })
    expect(generateSummary).not.toHaveBeenCalled()
    expect(compacted).toEqual({ messages, record: null, didCompact: false })
  })

  it('does not separate a media call from a result inside the recent suffix', async () => {
    const messages = [{ role: 'assistant', content: 'Old text' }, calls, result, sibling]
    const compacted = await compactMessages(messages, {
      sessionId: 'media-boundary', runId: null, contextLimit: 1000,
      config: { preserveRecentMessages: 1 }, generateSummary: vi.fn().mockResolvedValue('Summary'),
    })
    expect(compacted.messages.slice(-3)).toEqual([calls, result, sibling])
    expect(compacted.record?.compressedMessageCount).toBe(1)
  })

  it.each(['image', 'file', 'document', 'audio', 'video', 'input_image', 'input_file'])(
    'excludes %s blocks even if they also have a text property', (type) => {
      expect(serializeMessagesForSummary([{ role: 'user', content: [
        { type, text: 'ATTACHMENT_TEXT_SECRET', data: 'ATTACHMENT_BYTES_SECRET' },
      ] }])).toBe('')
    },
  )
})
