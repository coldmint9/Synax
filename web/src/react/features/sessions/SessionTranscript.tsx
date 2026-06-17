import { useEffect, useRef, type RefObject } from 'react'
import { useParams } from 'react-router-dom'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { AgentConversationView } from './AgentConversationView'
import { SessionGoalComposer } from './SessionGoalComposer'
import { SessionNavigationPanel } from './SessionNavigationPanel'
import { isGoalSession } from './sessionBuckets'

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>
}

export function SessionTranscript({ scrollRef }: Props) {
  const { projectId = '' } = useParams()

  const session = useDebugConsole((s) => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(ss => ss.id === id) : undefined
  })
  const runs = useDebugConsole((s) => s.runs)
  const steps = useDebugConsole((s) => s.steps)
  const toolCalls = useDebugConsole((s) => s.toolCalls)
  const messages = useDebugConsole((s) => s.messages)
  const childSessions = useDebugConsole((s) => {
    const id = s.selectedSessionId
    return id ? s.childSessions[id] : undefined
  })
  const pauseSession = useDebugConsole((s) => s.pauseSession)
  const resumeSession = useDebugConsole((s) => s.resumeSession)
  const streamingStepId = useDebugConsole((s) => s.streamingStepId)
  const streamingText = useDebugConsole((s) => s.streamingText)
  const streamingThinking = useDebugConsole((s) => s.streamingThinking)
  const streamingToolCalls = useDebugConsole((s) => s.streamingToolCalls)
  const streamingCompletedSteps = useDebugConsole((s) => s.streamingCompletedSteps)
  const permissions = useDebugConsole((s) => s.permissions)
  const replyPermission = useDebugConsole((s) => s.replyPermission)

  const showGoalComposer = Boolean(session && isGoalSession(session))

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [steps.length, messages.length, streamingText, streamingThinking, streamingToolCalls.length])

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <AgentConversationView
            session={session}
            runs={runs}
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
            permissions={permissions}
            onReplyPermission={replyPermission}
            scrollContainerRef={scrollRef}
          />
        </div>
        <SessionNavigationPanel scrollRootRef={scrollRef} />
      </div>
      {showGoalComposer && session && (
        <SessionGoalComposer session={session} projectId={projectId} />
      )}
    </div>
  )
}
