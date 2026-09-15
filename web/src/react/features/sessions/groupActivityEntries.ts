import type { ConversationTimelineEntry } from './buildConversationTimeline'

/** Replies and user/system events end an activity group; model steps do not. */
export function groupActivityEntries(entries: ConversationTimelineEntry[]): ConversationTimelineEntry[] {
  const result: ConversationTimelineEntry[] = []
  let pending: Extract<ConversationTimelineEntry, { kind: 'agent' }> | undefined
  const flush = () => {
    if (pending) result.push(pending)
    pending = undefined
  }
  for (const entry of entries) {
    if (entry.kind !== 'agent') {
      flush()
      result.push(entry)
      continue
    }
    entry.turn.blocks.forEach((block, index) => {
      const activity = block.type === 'thinking' || block.type === 'tool_call' || block.type === 'tool_call_group'
      if (block.type === 'text' && !block.content.trim()) return
      if (activity) {
        if (!pending) pending = { ...entry, id: `${entry.id}:activity:${index}`, turn: { ...entry.turn, blocks: [] } }
        pending.turn.blocks.push(block)
        pending.turn.status = entry.turn.status
      } else {
        flush()
        result.push({ ...entry, id: `${entry.id}:content:${index}`, turn: { ...entry.turn, blocks: [block] } })
      }
    })
  }
  flush()
  return result
}
