import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  Inbox,
  Link2,
  RefreshCw,
  Route,
  Send,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  ContextBindingRelation,
  ContextBlock,
  ContextSignal,
  CoordinatesContextIndex,
  CoordNode,
  SynapseNodeContext,
} from '../../../../lib/coordinates'
import {
  acceptContextSuggestion,
  dismissContextSuggestion,
  fetchSynapseNodeContext,
  shareContextSignal,
} from '../../../../lib/api/coordinates'
import { useContextStore } from '../../../state/contextStore'

interface ContextPanelProps {
  open: boolean
  selectedNode?: CoordNode | null
  contextIndex: CoordinatesContextIndex
  onBindContextBlock: (nodeId: string, blockId: string, relation?: ContextBindingRelation) => void
  onRefreshContext: () => void
  onClose: () => void
  onSelectNode?: (nodeId: string) => void
}

const KIND_STYLE: Record<string, string> = {
  decision: 'bg-sky-500/10 text-sky-400',
  risk: 'bg-rose-500/10 text-rose-400',
  constraint: 'bg-amber-500/10 text-amber-400',
  evidence: 'bg-emerald-500/10 text-emerald-400',
  artifact: 'bg-violet-500/10 text-violet-400',
  correction: 'bg-orange-500/10 text-orange-400',
  insight: 'bg-primary/10 text-primary',
}

function fmtIso(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function Section({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string
  icon: React.ComponentType<{ size?: number }>
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/45 bg-background/70 text-muted-foreground">
          <Icon size={12} />
        </span>
        <div className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {title}
        </div>
        {typeof count === 'number' && (
          <span className="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/50 bg-background/40 px-3 py-5 text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </div>
  )
}

function KindPill({ kind }: { kind: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${KIND_STYLE[kind] ?? 'bg-secondary text-muted-foreground'}`}>
      {kind}
    </span>
  )
}

function SignalCard({
  signal,
  block,
  footer,
  actions,
}: {
  signal: ContextSignal
  block?: ContextBlock | null
  footer?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/45 bg-background/55 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <KindPill kind={signal.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground">
            {signal.title || block?.title}
          </div>
          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
            {signal.summary || block?.content}
          </div>
        </div>
        <span className="font-mono text-[9px] text-muted-foreground">
          {(signal.confidence * 100).toFixed(0)}%
        </span>
      </div>
      {(footer || actions) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-[10px] text-muted-foreground">{footer}</div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
    </div>
  )
}

function MiniButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="inline-flex h-6 items-center gap-1 rounded-md border border-border/45 bg-card px-2 text-[10px] font-medium text-muted-foreground transition hover:border-primary/45 hover:bg-primary/8 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export default function ContextPanel({
  open,
  selectedNode,
  contextIndex,
  onRefreshContext,
  onClose,
}: ContextPanelProps) {
  const projectId = useContextStore((s) => s.projectId)
  const syncStatus = useContextStore((s) => s.syncStatus)
  const [synapse, setSynapse] = useState<SynapseNodeContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const recentProjectSignals = useMemo(
    () => (contextIndex.signals ?? []).slice(0, 8),
    [contextIndex.signals],
  )

  const loadSynapse = async () => {
    if (!projectId || !selectedNode) {
      setSynapse(null)
      return
    }
    setLoading(true)
    try {
      setSynapse(await fetchSynapseNodeContext(projectId, selectedNode.id))
      setMessage(null)
    } catch (err) {
      setMessage((err as Error).message)
      setSynapse(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void loadSynapse()
  }, [open, projectId, selectedNode?.id, contextIndex.headRevision])

  const refreshAll = async () => {
    onRefreshContext()
    await loadSynapse()
  }

  const accept = async (suggestionId: string) => {
    if (!projectId) return
    setBusyId(suggestionId)
    try {
      await acceptContextSuggestion({ projectId, suggestionId })
      await refreshAll()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = async (suggestionId: string) => {
    if (!projectId) return
    setBusyId(suggestionId)
    try {
      await dismissContextSuggestion({ projectId, suggestionId })
      await refreshAll()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const share = async (signalId: string) => {
    if (!projectId) return
    setBusyId(signalId)
    try {
      const result = await shareContextSignal({ projectId, signalId })
      setMessage(result.items.length > 0 ? `Prepared ${result.items.length} handoff suggestion(s).` : 'No target found for this signal.')
      await refreshAll()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  if (!open) return null

  return (
    <aside className="absolute right-0 top-0 z-30 flex h-full w-[420px] shrink-0 flex-col border-l border-border/60 bg-card/96 shadow-xl backdrop-blur-sm">
      <div className="border-b border-border/45 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
                <Sparkles size={14} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">Synapse Context</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {selectedNode ? selectedNode.label : 'Select a node to inspect signal flow'}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                <Activity size={10} />
                {syncStatus}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                <Inbox size={10} />
                {synapse?.incoming.length ?? 0} incoming
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                <Link2 size={10} />
                {synapse?.inputs.length ?? 0} inputs
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                <Route size={10} />
                {synapse?.handoffs.length ?? 0} handoffs
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refreshAll()}
              className="rounded p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close context panel"
              className="rounded p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {message && (
          <div className="mt-2 rounded-md border border-border/45 bg-background/65 px-3 py-1.5 text-[10px] text-muted-foreground">
            {message}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!selectedNode ? (
          <Section title="Recent Signals" icon={Sparkles} count={recentProjectSignals.length}>
            {recentProjectSignals.length > 0 ? (
              <div className="space-y-1.5">
                {recentProjectSignals.map((signal) => (
                  <SignalCard
                    key={signal.id}
                    signal={signal}
                    footer={`${signal.sourceNodeId ?? 'project'} · ${fmtIso(signal.createdAt)}`}
                  />
                ))}
              </div>
            ) : (
              <Empty>Agent runs will produce focused signals here after a node finishes executing.</Empty>
            )}
          </Section>
        ) : (
          <>
            <Section title="Incoming Signals" icon={Inbox} count={synapse?.incoming.length ?? 0}>
              {synapse && synapse.incoming.length > 0 ? (
                <div className="space-y-1.5">
                  {synapse.incoming.map(({ suggestion, signal, block }) => (
                    <SignalCard
                      key={suggestion.id}
                      signal={signal}
                      block={block}
                      footer={suggestion.reason}
                      actions={
                        <>
                          <MiniButton
                            onClick={() => void accept(suggestion.id)}
                            disabled={busyId === suggestion.id}
                            title="Accept as next agent input"
                          >
                            <Check size={11} />
                            Accept
                          </MiniButton>
                          <MiniButton
                            onClick={() => void dismiss(suggestion.id)}
                            disabled={busyId === suggestion.id}
                            title="Dismiss this signal"
                          >
                            <X size={11} />
                          </MiniButton>
                        </>
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty>No incoming signals are waiting for this node.</Empty>
              )}
            </Section>

            <Section title="Agent Inputs" icon={Link2} count={synapse?.inputs.length ?? 0}>
              {synapse && synapse.inputs.length > 0 ? (
                <div className="space-y-1.5">
                  {synapse.inputs.map(({ binding, block, signal }) => (
                    <div key={binding.id} className="rounded-lg border border-border/45 bg-background/55 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <KindPill kind={signal?.kind ?? block.kind} />
                        <span className="rounded bg-secondary/70 px-1 py-px font-mono text-[9px] text-muted-foreground">
                          {binding.relation}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{block.title}</span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {signal?.summary ?? block.content}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>Accepted signals will become the context this node sends into its next agent run.</Empty>
              )}
            </Section>

            <Section title="This Node Produced" icon={Bot} count={synapse?.produced.length ?? 0}>
              {synapse && synapse.produced.length > 0 ? (
                <div className="space-y-1.5">
                  {synapse.produced.map(({ signal, block }) => (
                    <SignalCard
                      key={signal.id}
                      signal={signal}
                      block={block}
                      footer={`${signal.sourceRunId?.slice(0, 8) ?? 'run'} · ${fmtIso(signal.createdAt)}`}
                      actions={
                        <MiniButton
                          onClick={() => void share(signal.id)}
                          disabled={busyId === signal.id}
                          title="Prepare handoff suggestions"
                        >
                          <Send size={11} />
                          Share
                        </MiniButton>
                      }
                    />
                  ))}
                </div>
              ) : (
                <Empty>This node has not produced durable signals yet. Run its agent to generate them.</Empty>
              )}
            </Section>

            <Section title="Suggested Handoffs" icon={Route} count={synapse?.handoffs.length ?? 0}>
              {synapse && synapse.handoffs.length > 0 ? (
                <div className="space-y-1.5">
                  {synapse.handoffs.map(({ suggestion, signal, targetLabel }) => (
                    <div key={suggestion.id} className="rounded-lg border border-border/45 bg-background/55 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <KindPill kind={signal.kind} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{signal.title}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <ArrowRight size={11} />
                        <span className="truncate">{targetLabel ?? suggestion.targetNodeId}</span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                        {suggestion.reason}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>No handoff is pending from this node.</Empty>
              )}
            </Section>

            <Section title="Run Memory" icon={Activity} count={synapse?.recentLoops.length ?? 0}>
              {synapse?.latestLoop ? (
                <div className="rounded-lg border border-border/45 bg-background/55 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-secondary/70 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                      {synapse.latestLoop.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                      {synapse.latestLoop.summary ?? synapse.latestLoop.finalOutput ?? synapse.latestLoop.runId}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {fmtIso(synapse.latestLoop.completedAt ?? synapse.latestLoop.startedAt)}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {(synapse.latestLoop.steps ?? synapse.latestLoop.transcript.steps).slice(0, 6).map((step) => (
                      <div key={`${synapse.latestLoop?.id}-${step.sequence}`} className="flex items-start gap-2 text-[10px] text-muted-foreground">
                        <span className="mt-0.5 shrink-0 rounded bg-secondary/60 px-1 py-px font-mono uppercase">
                          {step.kind}
                        </span>
                        <span className="line-clamp-1">{step.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <Empty>No complete agent loop has been recorded for this node.</Empty>
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  )
}
