import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'
import { SessionLiveTurn } from './SessionLiveTurn'
import { SessionNavigationPanel } from './SessionNavigationPanel'

function useSessionTranscriptStatic() {
  return useAgentSessionStore(useShallow(s => {
    const id = s.selectedSessionId
    return {
      session: id ? s.sessions.find(ss => ss.id === id) : undefined,
      runs: s.runs,
      steps: s.steps,
      toolCalls: s.toolCalls,
      messages: s.messages,
      childSessions: id ? s.childSessions[id] : undefined,
      streamingStepId: s.streamingStepId,
      pauseSession: s.pauseSession,
      resumeSession: s.resumeSession,
    }
  }))
}

function useSessionLiveState() {
  return useAgentSessionStore(useShallow(s => ({
    steps: s.steps,
    streamingStepId: s.streamingStepId,
    streamingLive: s.streamingLive,
    streamingCompletedSteps: s.streamingCompletedSteps,
  })))
}

function SessionLiveTurnLayer({
  scrollContainerRef,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}) {
  const liveState = useSessionLiveState()
  return (
    <SessionLiveTurn
      steps={liveState.steps}
      streamingStepId={liveState.streamingStepId}
      streamingLive={liveState.streamingLive}
      streamingCompletedSteps={liveState.streamingCompletedSteps}
      scrollContainerRef={scrollContainerRef}
    />
  )
}

export function SessionTranscript() {
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    session,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
    pauseSession,
    resumeSession,
  } = useSessionTranscriptStatic()

  const streamingStep = streamingStepId ? steps.find(s => s.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')

  // Transcript entries reserve an estimated height until the viewport reaches
  // them, so the scroll height keeps growing after the first paint. While the
  // reader is sitting at the bottom we follow that growth; as soon as they
  // scroll away we stop moving the viewport for them.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const content = element.firstElementChild

    const distanceFromBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight
    let pinned = true
    const handleScroll = () => { pinned = distanceFromBottom() <= 48 }
    element.addEventListener('scroll', handleScroll, { passive: true })
    element.scrollTop = element.scrollHeight

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (pinned) element.scrollTop = element.scrollHeight
        })
    if (observer && content) observer.observe(content)

    return () => {
      element.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
    }
  }, [session?.id])

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="session-chat-scroll h-full overflow-y-auto">
          <AgentConversationView
            session={session}
            runs={runs}
            steps={steps}
            toolCalls={toolCalls}
            messages={messages}
            childSessions={childSessions}
            onPause={pauseSession}
            onResume={(id) => resumeSession(id)}
            excludeStepId={showLiveBlock ? streamingStepId : null}
            liveTurn={<SessionLiveTurnLayer scrollContainerRef={scrollRef} />}
            scrollRootRef={scrollRef}
          />
        </div>
        <SessionNavigationPanel scrollRootRef={scrollRef} />
      </div>
    </div>
  )
}
