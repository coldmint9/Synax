import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, Send, X } from 'lucide-react'
import { Button, Card, Chip, ScrollShadow, Spinner } from '@heroui/react'
import {
  agentRuntimeApi,
  type AgentSession,
  type PermissionDecision,
  type RuntimeEvent,
} from '../../lib/api/agentRuntime'
import { useDebugConsole } from '../features/debug-console/debugConsoleStore'
import { useSessionLiveStream } from '../features/debug-console/useSessionLiveStream'
import { AgentConversationView } from '../features/sessions/AgentConversationView'
import { isProviderNotConfiguredError, LlmProviderRequiredBanner } from '../components/LlmProviderRequiredBanner'

type StreamChunk = {
  type?: string
  event?: RuntimeEvent
  permission?: PermissionDecision
}

const PROJECT_ID = 'agent-loop-test'
const PROFILE_ID = 'executor'

function formatTime(value?: string | null): string {
  if (!value) return ''
  try {
    return new Date(value).toLocaleTimeString()
  } catch {
    return value
  }
}

function shortId(value?: string | null): string {
  if (!value) return ''
  return value.length > 12 ? value.slice(-10) : value
}

export default function AgentLoopTestPage() {
  const [session, setSession] = useState<AgentSession | null>(null)
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [permissions, setPermissions] = useState<PermissionDecision[]>([])
  const [input, setInput] = useState('Read package.json and summarize it in one sentence.')
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  // Wire up debugConsoleStore for rich rendering
  const debugStore = useDebugConsole()
  const { steps, toolCalls, messages: storeMessages, childSessions,
    streamingStepId, streamingText, streamingThinking, streamingToolCalls,
    streamingCompletedSteps } = debugStore

  // Subscribe to SSE live events when session is active
  useSessionLiveStream(session?.id ?? null)

  const pendingPermissions = permissions.filter(
    (p) => p.action === 'ask' && !p.resolvedAt,
  )

  const refreshSessionData = useCallback(async (sessionId = sessionIdRef.current) => {
    if (!sessionId) return
    const [payload, eventList, permissionList] = await Promise.all([
      agentRuntimeApi.getSession(sessionId),
      agentRuntimeApi.listEvents(sessionId),
      agentRuntimeApi.listPermissions(sessionId),
    ])
    setSession(payload.session)
    setEvents(eventList.items)
    setPermissions(permissionList.items)
  }, [])

  const ensureSession = useCallback(async (): Promise<AgentSession> => {
    if (sessionIdRef.current && session) return session
    const payload = await agentRuntimeApi.createSession({
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      prompt: 'Agent loop test session.',
    })
    sessionIdRef.current = payload.session.id
    setSession(payload.session)
    return payload.session
  }, [session])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setStreaming(true)
    setError(null)
    try {
      const activeSession = await ensureSession()
      sessionIdRef.current = activeSession.id
      // Open panel in debugConsoleStore to load data and enable SSE rendering
      debugStore.openPanel(activeSession.id)
      await agentRuntimeApi.streamTurn(activeSession.id, { message: text }, (raw) => {
        const chunk = raw as StreamChunk
        if (chunk.event) {
          setEvents((current) => [...current, chunk.event!])
        }
        if (chunk.permission) {
          setPermissions((current) => {
            const withoutExisting = current.filter((item) => item.id !== chunk.permission!.id)
            return [...withoutExisting, chunk.permission!]
          })
        }
      })
      setInput('')
      await refreshSessionData(activeSession.id)
      await debugStore.refreshDetail()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStreaming(false)
    }
  }, [ensureSession, input, refreshSessionData, streaming, debugStore])

  const replyPermission = useCallback(
    async (permissionId: string, reply: 'once' | 'reject') => {
      if (!sessionIdRef.current) return
      setApprovingId(permissionId)
      setError(null)
      try {
        await agentRuntimeApi.replyPermission(sessionIdRef.current, permissionId, reply)
        await refreshSessionData(sessionIdRef.current)
        await debugStore.refreshDetail()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApprovingId(null)
      }
    },
    [refreshSessionData, debugStore],
  )

  // Sync session into store when sessionIdRef changes
  useEffect(() => {
    if (sessionIdRef.current && !debugStore.selectedSessionId) {
      debugStore.openPanel(sessionIdRef.current)
    }
  }, [session, debugStore])

  return (
    <div className="h-full overflow-hidden bg-background text-foreground">
      <div className="flex h-full">
        {/* Left sidebar */}
        <aside className="hidden w-72 shrink-0 border-r border-border bg-card/60 p-5 lg:block">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Synax Runtime</p>
            <h1 className="mt-2 text-xl font-semibold">Agent Loop Test</h1>
          </div>

          <div className="mt-6 space-y-3 text-sm">
            <InfoRow label="Project" value={PROJECT_ID} />
            <InfoRow label="Profile" value={PROFILE_ID} />
            <InfoRow label="Session" value={session ? shortId(session.id) : 'not created'} />
            <InfoRow label="Status" value={session?.status ?? 'idle'} />
          </div>

          <Button
            variant="outline"
            size="sm"
            className="mt-6 w-full"
            onPress={() => { void refreshSessionData(); void debugStore.refreshDetail() }}
            isDisabled={!sessionIdRef.current}
          >
            <RefreshCw size={14} />
            Refresh
          </Button>
        </aside>

        {/* Main content */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            {/* Conversation area */}
            <section className="flex min-h-0 flex-col border-r border-border">
              <div className="min-h-0 flex-1 overflow-auto">
                <AgentConversationView
                  session={session ?? undefined}
                  steps={steps}
                  toolCalls={toolCalls}
                  messages={storeMessages}
                  childSessions={childSessions[sessionIdRef.current ?? ''] ?? []}
                  streamingStepId={streamingStepId}
                  streamingText={streamingText}
                  streamingThinking={streamingThinking}
                  streamingToolCalls={streamingToolCalls}
                  streamingCompletedSteps={streamingCompletedSteps}
                />
              </div>

              {error && (
                isProviderNotConfiguredError(error) ? (
                  <div className="border-t border-destructive/30 px-5 py-3">
                    <LlmProviderRequiredBanner error={error} onDismiss={() => setError(null)} />
                  </div>
                ) : (
                  <div className="border-t border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive">
                    {error}
                  </div>
                )
              )}

              {pendingPermissions.length > 0 && (
                <div className="border-t border-warning/40 bg-warning/10 px-5 py-3">
                  <div className="space-y-2">
                    {pendingPermissions.map((permission) => (
                      <div key={permission.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-background px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{permission.reason}</p>
                          <p className="text-xs text-muted-foreground">
                            {permission.internalGate} · {permission.patterns.join(', ')}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" onPress={() => void replyPermission(permission.id, 'once')} isDisabled={approvingId === permission.id}>
                            <Check size={13} /> Allow
                          </Button>
                          <Button size="sm" variant="outline" onPress={() => void replyPermission(permission.id, 'reject')} isDisabled={approvingId === permission.id}>
                            <X size={13} /> Reject
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <form
                className="border-t border-border p-4"
                onSubmit={(e) => { e.preventDefault(); void send() }}
              >
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="min-h-20 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
                    placeholder="Send a task to the agent loop..."
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault(); void send()
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={streaming || !input.trim()}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Send"
                  >
                    {streaming ? <Spinner size="sm" /> : <Send size={16} />}
                  </button>
                </div>
              </form>
            </section>

            {/* Events sidebar */}
            <aside className="hidden min-h-0 overflow-auto bg-card/50 p-4 lg:block">
              <h3 className="text-sm font-semibold mb-3">Runtime Events</h3>
              <ScrollShadow className="flex-1">
                {events.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                    No events yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {events.slice().reverse().slice(0, 50).map((event) => (
                      <Card key={event.id} className="shadow-none border-border/60 bg-background/60">
                        <div className="px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <Chip size="sm" variant="soft" className="text-[9px] h-4">
                              {event.type}
                            </Chip>
                            <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(event.timestamp)}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{event.summary}</p>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </ScrollShadow>
            </aside>
          </div>
        </main>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xs font-medium">{value}</span>
    </div>
  )
}
