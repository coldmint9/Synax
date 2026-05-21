import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, RefreshCw, Send, X } from 'lucide-react'
import {
  agentRuntimeApi,
  type AgentRuntimeMessage,
  type AgentSession,
  type PermissionDecision,
  type RuntimeEvent,
} from '../../lib/api/agentRuntime'

type StreamChunk = {
  type?: string
  event?: RuntimeEvent
  message?: AgentRuntimeMessage
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
  const [messages, setMessages] = useState<AgentRuntimeMessage[]>([])
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [permissions, setPermissions] = useState<PermissionDecision[]>([])
  const [input, setInput] = useState('Read package.json and summarize it in one sentence.')
  const [error, setError] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const pendingPermissions = useMemo(
    () => permissions.filter((permission) => permission.action === 'ask' && !permission.resolvedAt),
    [permissions],
  )

  const refreshSessionData = useCallback(async (sessionId = sessionIdRef.current) => {
    if (!sessionId) return
    const [payload, messageList, eventList, permissionList] = await Promise.all([
      agentRuntimeApi.getSession(sessionId),
      agentRuntimeApi.listMessages(sessionId),
      agentRuntimeApi.listEvents(sessionId),
      agentRuntimeApi.listPermissions(sessionId),
    ])
    setSession(payload.session)
    setMessages(messageList.items)
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
      await agentRuntimeApi.streamTurn(activeSession.id, { message: text }, (raw) => {
        const chunk = raw as StreamChunk
        if (chunk.message) {
          setMessages((current) => [...current, chunk.message!])
        }
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStreaming(false)
    }
  }, [ensureSession, input, refreshSessionData, streaming])

  const replyPermission = useCallback(
    async (permissionId: string, reply: 'once' | 'reject') => {
      if (!sessionIdRef.current) return
      setApprovingId(permissionId)
      setError(null)
      try {
        await agentRuntimeApi.replyPermission(sessionIdRef.current, permissionId, reply)
        await refreshSessionData(sessionIdRef.current)
        window.setTimeout(() => void refreshSessionData(sessionIdRef.current), 700)
        window.setTimeout(() => void refreshSessionData(sessionIdRef.current), 1600)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApprovingId(null)
      }
    },
    [refreshSessionData],
  )

  useEffect(() => {
    if (!sessionIdRef.current) return
    const timer = window.setInterval(() => {
      void refreshSessionData(sessionIdRef.current)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [refreshSessionData])

  return (
    <div className="h-full overflow-hidden bg-background text-foreground">
      <div className="flex h-full">
        <aside className="hidden w-80 shrink-0 border-r border-border bg-card/60 p-5 lg:block">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Synapse Runtime</p>
            <h1 className="mt-2 text-xl font-semibold">Agent Loop Test</h1>
          </div>

          <div className="mt-6 space-y-3 text-sm">
            <InfoRow label="Project" value={PROJECT_ID} />
            <InfoRow label="Profile" value={PROFILE_ID} />
            <InfoRow label="Session" value={session ? shortId(session.id) : 'not created'} />
            <InfoRow label="Status" value={session?.status ?? 'idle'} />
            <InfoRow label="Active run" value={shortId(session?.activeRunId) || '-'} />
          </div>

          <button
            type="button"
            onClick={() => void refreshSessionData()}
            disabled={!sessionIdRef.current}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={14} />
            Refresh
          </button>

          <div className="mt-6 rounded-md border border-border bg-background/60 p-3 text-xs text-muted-foreground">
            Try a write prompt such as: write "hello" to tmp/agent-loop-ui-test.txt.
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Chat</h2>
                <p className="text-xs text-muted-foreground">
                  {session ? `${session.status} · ${shortId(session.id)}` : 'A session is created on first send'}
                </p>
              </div>
              {streaming && (
                <div className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  running
                </div>
              )}
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
            <section className="flex min-h-0 flex-col border-r border-border">
              <div className="min-h-0 flex-1 overflow-auto p-5">
                <div className="mx-auto flex max-w-3xl flex-col gap-3">
                  {messages.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                      No messages yet.
                    </div>
                  ) : (
                    messages.map((message) => (
                      <MessageBubble key={message.id} message={message} />
                    ))
                  )}
                </div>
              </div>

              {error && (
                <div className="border-t border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {pendingPermissions.length > 0 && (
                <div className="border-t border-warning/40 bg-warning/10 px-5 py-3">
                  <div className="mx-auto max-w-3xl space-y-2">
                    {pendingPermissions.map((permission) => (
                      <div key={permission.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-background px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{permission.reason}</p>
                          <p className="text-xs text-muted-foreground">
                            {permission.internalGate} · {permission.patterns.join(', ')}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void replyPermission(permission.id, 'once')}
                            disabled={approvingId === permission.id}
                            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
                          >
                            <Check size={13} />
                            Allow once
                          </button>
                          <button
                            type="button"
                            onClick={() => void replyPermission(permission.id, 'reject')}
                            disabled={approvingId === permission.id}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-60"
                          >
                            <X size={13} />
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <form
                className="border-t border-border p-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
              >
                <div className="mx-auto flex max-w-3xl items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    className="min-h-20 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
                    placeholder="Send a task to the built-in Synapse agent loop..."
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault()
                        void send()
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={streaming || !input.trim()}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Send"
                  >
                    {streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </form>
            </section>

            <aside className="min-h-0 overflow-auto bg-card/50 p-4">
              <h3 className="text-sm font-semibold">Runtime Events</h3>
              <div className="mt-3 space-y-2">
                {events.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                    No events yet.
                  </div>
                ) : (
                  events.slice().reverse().map((event) => (
                    <div key={event.id} className="rounded-md border border-border bg-background p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium">{event.type}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(event.timestamp)}</span>
                      </div>
                      <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{event.summary}</p>
                    </div>
                  ))
                )}
              </div>
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

function MessageBubble({ message }: { message: AgentRuntimeMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[82%] rounded-md border px-3 py-2 text-sm leading-6',
          isUser
            ? 'border-primary/30 bg-primary text-primary-foreground'
            : 'border-border bg-card text-card-foreground',
        ].join(' ')}
      >
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] opacity-70">
          <span>{message.role}</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    </div>
  )
}
