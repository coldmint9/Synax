import { useEffect, useRef } from 'react'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { AgentConversationView } from './AgentConversationView'
import { PermissionApprovalBar } from './PermissionApprovalBar'

export function SessionTranscript() {
  const scrollRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [steps.length, streamingText, streamingThinking, streamingToolCalls.length])

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
