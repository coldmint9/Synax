import { Check, Lock, Pencil, X } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { wikiApi } from '../../../lib/api/wiki'
import type { WikiBlock } from '../../../lib/contracts/wiki'

interface WikiBlockEditorProps {
  block: WikiBlock
  onClose: () => void
}

function getEditableText(block: WikiBlock): string {
  if (block.contentFormat === 'markdown_fragment' && typeof block.content === 'string') {
    return block.content
  }
  const c = block.content as Record<string, unknown>
  if (block.blockType === 'heading') return (c.text as string) ?? ''
  if (block.blockType === 'paragraph') return (c.text as string) ?? ''
  if (block.blockType === 'list') return ((c.items as string[]) ?? []).join('\n')
  return JSON.stringify(block.content, null, 2)
}

function buildUpdatedContent(block: WikiBlock, text: string): unknown {
  if (block.contentFormat === 'markdown_fragment') return text
  if (block.blockType === 'heading') return { ...(block.content as object), text }
  if (block.blockType === 'paragraph') return { ...(block.content as object), text }
  if (block.blockType === 'list') {
    return { ...(block.content as object), items: text.split('\n').filter(Boolean) }
  }
  try { return JSON.parse(text) } catch { return text }
}

export default function WikiBlockEditor({ block, onClose }: WikiBlockEditorProps) {
  const updateBlockLocally = useWikiStore(s => s.updateBlockLocally)
  const [text, setText] = useState(getEditableText(block))
  const [saving, setSaving] = useState(false)
  const [lockAfterSave, setLockAfterSave] = useState(block.manualState === 'locked')

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await wikiApi.updateBlock(block.id, {
        content: buildUpdatedContent(block, text),
        manualState: lockAfterSave ? 'locked' : 'edited',
      })
      updateBlockLocally(updated)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-card/80 p-3 space-y-2 shadow-sm">
      <textarea
        className="w-full resize-none rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-[13px] text-foreground leading-relaxed focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 min-h-[80px]"
        value={text}
        onChange={e => setText(e.target.value)}
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={lockAfterSave}
            onChange={e => setLockAfterSave(e.target.checked)}
            className="rounded"
          />
          <Lock size={10} className="text-muted-foreground/60" />
          <span className="text-[11px] text-muted-foreground/70">Lock (AI 不可覆盖)</span>
        </label>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary transition-colors"
          >
            <X size={10} />
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1 rounded-lg bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
          >
            <Check size={10} />
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
