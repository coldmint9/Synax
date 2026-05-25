import { useEffect, useMemo, useRef } from 'react'
import { useContextStore } from '../../state/contextStore'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { TranscriptEntry } from './TranscriptEntry'
import { AgentConversationView } from './AgentConversationView'
import { PermissionApprovalBar } from './PermissionApprovalBar'

interface Props {
  mode: 'context' | 'agent'
}

export function SessionTranscript({ mode }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Context session data
  const entries = useContextStore((s) => s.entries)
  const loadingEntries = useContextStore((s) => s.loading.entries)

  // Agent session data
  const session = useDebugConsole((s) => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(ss => ss.id === id) : undefined
  })
  const steps = useDebugConsole((s) => s.steps)
  const toolCalls = useDebugConsole((s) => s.toolCalls)
  const messages = useDebugConsole((s) => s.messages)
  const childSessions = useDebugConsole((s) => {
    const id = s.selectedSessionId
    return id ? s.childSessions[id] : undefined
  })
  const pauseSession = useDebugConsole((s) => s.pauseSession)
  const resumeSession = useDebugConsole((s) => s.resumeSession)
  const permissions = useDebugConsole((s) => s.permissions)
  const replyPermission = useDebugConsole((s) => s.replyPermission)
  const streamingStepId = useDebugConsole((s) => s.streamingStepId)
  const streamingText = useDebugConsole((s) => s.streamingText)
  const streamingThinking = useDebugConsole((s) => s.streamingThinking)
  const streamingToolCalls = useDebugConsole((s) => s.streamingToolCalls)
  const streamingCompletedSteps = useDebugConsole((s) => s.streamingCompletedSteps)

  const orderedEntries = useMemo(
    () => [...entries].sort((a, b) => a.sequence - b.sequence),
    [entries],
  )

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [orderedEntries.length, steps.length, streamingText, streamingToolCalls.length])

  if (mode === 'agent') {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <AgentConversationView
            session={session}
            steps={steps}
            toolCalls={toolCalls}
            messages={messages}
            childSessions={childSessions}
            onPause={pauseSession}
            onResume={(id) => resumeSession(id)}
            streamingStepId={streamingStepId}
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            streamingToolCalls={streamingToolCalls}
            streamingCompletedSteps={streamingCompletedSteps}
          />
        </div>
        <PermissionApprovalBar
          permissions={permissions}
          onReply={replyPermission}
        />
      </div>
    )
  }

  // Context mode
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
      {loadingEntries && orderedEntries.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground/60">
          加载中…
        </div>
      ) : orderedEntries.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground/60">
          尚无条目
        </div>
      ) : (
        <div className="divide-y divide-border/20 py-1">
          {orderedEntries.map((entry) => (
            <TranscriptEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
