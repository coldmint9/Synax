import { Code2, ExternalLink, FileText, Hash, Layers, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { wikiApi } from '../../../lib/api/wiki'
import type { WikiBlock, WikiSourceBinding } from '../../../lib/contracts/wiki'

const PRECISION_LABELS = {
  ast: { label: 'AST', cls: 'bg-success/15 text-success' },
  symbol: { label: 'Symbol', cls: 'bg-primary/15 text-primary' },
  chunk: { label: 'Chunk', cls: 'bg-secondary text-muted-foreground' },
  file: { label: 'File', cls: 'bg-secondary text-muted-foreground/70' },
} as const

function BindingItem({ binding }: { binding: WikiSourceBinding }) {
  const { label, cls } = PRECISION_LABELS[binding.precision] ?? PRECISION_LABELS.file
  const [jumping, setJumping] = useState(false)

  const icon = binding.sourceType === 'file'
    ? <FileText size={11} className="shrink-0 text-muted-foreground/60" />
    : binding.sourceType === 'symbol'
    ? <Hash size={11} className="shrink-0 text-muted-foreground/60" />
    : <Code2 size={11} className="shrink-0 text-muted-foreground/60" />

  async function handleJump() {
    setJumping(true)
    try {
      const res = await wikiApi.resolveBinding(binding.id)
      if (res.ideUri) {
        window.open(res.ideUri, '_blank')
      } else if (res.fallbackSearchQuery) {
        // No IDE URI — copy the search query to clipboard as fallback
        await navigator.clipboard.writeText(res.fallbackSearchQuery).catch(() => {})
        alert(`无法生成 IDE 跳转链接。已复制搜索词：${res.fallbackSearchQuery}`)
      } else {
        alert('无法解析源码位置。')
      }
    } catch {
      alert('解析失败，请稍后重试。')
    } finally {
      setJumping(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/30 bg-card/50 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-foreground/80">
          {binding.sourceId}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${cls}`}>
          {label}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/50">
          confidence {Math.round(binding.confidence * 100)}%
        </span>
        <button
          type="button"
          onClick={handleJump}
          disabled={jumping}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40"
          title="在 VS Code 中打开"
        >
          {jumping ? <Loader2 size={9} className="animate-spin" /> : <ExternalLink size={9} />}
          jump
        </button>
      </div>
    </div>
  )
}

function BlockSourcePanel({ block }: { block: WikiBlock }) {
  const bindingsById = useWikiStore(s => s.bindingsById)
  const bindings = block.sourceBindingIds
    .map(id => bindingsById[id])
    .filter((b): b is WikiSourceBinding => Boolean(b))

  if (bindings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-6 text-center">
        <Layers size={16} className="text-muted-foreground/20" />
        <p className="text-[11px] text-muted-foreground/40">无 source binding</p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {bindings.map(b => <BindingItem key={b.id} binding={b} />)}
    </div>
  )
}

export default function WikiSourcePanel() {
  const blocksById = useWikiStore(s => s.blocksById)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const documents = useWikiStore(s => s.documents)
  const doc = documents.find(d => d.id === selectedDocumentId)

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[11px] text-muted-foreground/40">选择文档查看 source</p>
      </div>
    )
  }

  const blocks = doc.blockIds
    .map(id => blocksById[id])
    .filter((b): b is WikiBlock => Boolean(b))
    .filter(b => b.sourceBindingIds.length > 0)

  if (blocks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Layers size={20} className="text-muted-foreground/20" />
        <p className="text-[11px] text-muted-foreground/40">此文档暂无 source binding</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Source Evidence
      </div>
      {blocks.map(block => (
        <div key={block.id} className="space-y-1.5">
          <div className="text-[11px] font-medium text-foreground/60 truncate">
            {(block.content as { text?: string })?.text?.slice(0, 40) ?? block.blockType}
          </div>
          <BlockSourcePanel block={block} />
        </div>
      ))}
    </div>
  )
}
