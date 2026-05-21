import { FileText, Hash, Heading, List, Table, Code2, AlertTriangle, Lightbulb, Layers } from 'lucide-react'
import { useWikiStore } from '../../state/wikiStore'
import type { WikiBlock } from '../../../lib/contracts/wiki'

const BLOCK_TYPE_META: Record<string, { icon: typeof FileText; label: string }> = {
  heading: { icon: Heading, label: 'H' },
  paragraph: { icon: FileText, label: 'P' },
  list: { icon: List, label: 'List' },
  table: { icon: Table, label: 'Table' },
  diagram: { icon: Hash, label: 'Diagram' },
  code_ref: { icon: Code2, label: 'Code' },
  decision: { icon: Lightbulb, label: 'Decision' },
  risk: { icon: AlertTriangle, label: 'Risk' },
}

function blockPreview(block: WikiBlock): string {
  const c = block.content as Record<string, unknown>
  if (typeof c === 'string') return c.slice(0, 60)
  if (c?.text && typeof c.text === 'string') return c.text.slice(0, 60)
  if (c?.title && typeof c.title === 'string') return c.title.slice(0, 60)
  if (c?.decision && typeof c.decision === 'string') return c.decision.slice(0, 60)
  if (c?.description && typeof c.description === 'string') return c.description.slice(0, 60)
  if (Array.isArray(c?.items)) return (c.items as string[])[0]?.slice(0, 60) ?? ''
  return block.blockType
}

function scrollToBlock(blockId: string) {
  const el = document.getElementById(`wiki-block-${blockId}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('wiki-block-highlight')
  setTimeout(() => el.classList.remove('wiki-block-highlight'), 1800)
}

function BlockIndexItem({ block, index }: { block: WikiBlock; index: number }) {
  const meta = BLOCK_TYPE_META[block.blockType] ?? BLOCK_TYPE_META.paragraph
  const Icon = meta.icon
  const preview = blockPreview(block)
  const isHeading = block.blockType === 'heading'
  const level = isHeading ? ((block.content as { level?: number })?.level ?? 2) : 0

  return (
    <button
      type="button"
      onClick={() => scrollToBlock(block.id)}
      className={`w-full text-left rounded-md px-2 py-1.5 hover:bg-secondary/60 transition-colors ${
        isHeading && level === 1 ? 'font-semibold' : ''
      }`}
      style={{ paddingLeft: isHeading ? `${(level - 1) * 8 + 8}px` : '8px' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[10px] text-muted-foreground/40 w-4 text-right">{index + 1}</span>
        <Icon size={10} className="shrink-0 text-muted-foreground/50" />
        <span className={`truncate text-[11px] ${isHeading ? 'text-foreground/90' : 'text-foreground/65'}`}>
          {preview}
        </span>
      </div>
    </button>
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
        <p className="text-[11px] text-muted-foreground/40">选择文档查看索引</p>
      </div>
    )
  }

  const blocks = doc.blockIds
    .map(id => blocksById[id])
    .filter((b): b is WikiBlock => Boolean(b))

  if (blocks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Layers size={20} className="text-muted-foreground/20" />
        <p className="text-[11px] text-muted-foreground/40">此文档暂无内容</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-3">
      <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Block 索引
      </div>
      {blocks.map((block, i) => (
        <BlockIndexItem key={block.id} block={block} index={i} />
      ))}
    </div>
  )
}
