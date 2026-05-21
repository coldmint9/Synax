import { AlertTriangle, Check, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { wikiApi } from '../../../lib/api/wiki'
import type { WikiPatch } from '../../../lib/contracts/wiki'

const RISK_STYLES = {
  low: 'border-success/30 bg-success/5',
  medium: 'border-warning/30 bg-warning/5',
  high: 'border-destructive/30 bg-destructive/5',
} as const

const RISK_BADGE = {
  low: 'bg-success/15 text-success',
  medium: 'bg-warning/15 text-warning',
  high: 'bg-destructive/15 text-destructive',
} as const

function PatchItem({
  patch,
  onAccept,
  onDismiss,
}: {
  patch: WikiPatch
  onAccept: (id: string, confirmOverride?: boolean) => Promise<void>
  onDismiss: (id: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [conflictPending, setConflictPending] = useState(false)

  async function handleAccept() {
    setLoading(true)
    try {
      await onAccept(patch.id, conflictPending)
      setConflictPending(false)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('manual_override_required')) {
        setConflictPending(true)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleDismiss() {
    setLoading(true)
    try {
      await onDismiss(patch.id)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${RISK_STYLES[patch.risk]}`}>
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${RISK_BADGE[patch.risk]}`}>
              {patch.risk}
            </span>
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">
              {patch.kind}
            </span>
            <span className="text-[10px] text-muted-foreground/50">
              {Math.round(patch.confidence * 100)}% confidence
            </span>
          </div>
          {patch.reasoning.length > 0 && (
            <p className="mt-1 text-[11px] text-foreground/70 leading-snug line-clamp-2">
              {patch.reasoning[0]}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="shrink-0 rounded p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {/* Expanded reasoning */}
      {expanded && patch.reasoning.length > 1 && (
        <div className="rounded-lg bg-background/50 p-2 space-y-1">
          {patch.reasoning.map((r, i) => (
            <p key={i} className="text-[11px] text-foreground/65 leading-snug">{r}</p>
          ))}
        </div>
      )}

      {/* Conflict warning */}
      {conflictPending && (
        <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2">
          <AlertTriangle size={11} className="shrink-0 text-warning mt-0.5" />
          <p className="text-[11px] text-warning leading-snug">
            此 block 已被人工编辑。确认覆盖？
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleAccept}
          disabled={loading}
          className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
            conflictPending
              ? 'bg-warning text-warning-foreground hover:bg-warning/90'
              : 'bg-primary/15 text-primary hover:bg-primary/25'
          }`}
        >
          <Check size={10} />
          {conflictPending ? '确认覆盖' : 'Accept'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={loading}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary transition-colors"
        >
          <X size={10} />
          Dismiss
        </button>
        {loading && <RefreshCw size={10} className="animate-spin text-muted-foreground/50" />}
      </div>
    </div>
  )
}

export default function WikiPatchQueue({ projectId }: { projectId: string }) {
  const patchesById = useWikiStore(s => s.patchesById)
  const loadPatches = useWikiStore(s => s.loadPatches)
  const updateBlockLocally = useWikiStore(s => s.updateBlockLocally)

  const patches = Object.values(patchesById).filter(p => p.status === 'pending' || p.status === 'conflict')

  async function handleAccept(patchId: string, confirmManualOverride = false) {
    try {
      await fetch(`/api/wiki/patches/${patchId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmManualOverride }),
      }).then(async r => {
        if (r.status === 409) {
          const data = await r.json() as { code?: string }
          if (data.code === 'manual_override_required') {
            throw new Error('manual_override_required')
          }
        }
      })
      await loadPatches(projectId, 'pending')
    } catch (err) {
      throw err
    }
  }

  async function handleDismiss(patchId: string) {
    await fetch(`/api/wiki/patches/${patchId}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    await loadPatches(projectId, 'pending')
  }

  if (patches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <Check size={18} className="text-muted-foreground/20" />
        <p className="text-[11px] text-muted-foreground/40">无待处理 patch</p>
      </div>
    )
  }

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Pending Patches ({patches.length})
      </div>
      {patches.map(patch => (
        <PatchItem
          key={patch.id}
          patch={patch}
          onAccept={handleAccept}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  )
}
