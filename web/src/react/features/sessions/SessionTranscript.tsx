import { useLocale } from '../../../hooks/useLocale'
import { useTranscriptScroll } from './useTranscriptScroll'
import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'
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
      resumeSession: s.resumeSession,
    }
  }))
}

export function SessionTranscript({ onReadingHistoryChange }: { onReadingHistoryChange?: (reading: boolean) => void }) {
  const { locale } = useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    session,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
    resumeSession,
  } = useSessionTranscriptStatic()

  const streamingStep = streamingStepId ? steps.find(s => s.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')

  useTranscriptScroll(scrollRef, session?.id, onReadingHistoryChange)

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} tabIndex={0} aria-label={locale === 'zh' ? '对话记录' : 'Conversation history'} className="session-chat-scroll h-full overflow-y-auto">
          <AgentConversationView
            session={session}
            runs={runs}
            steps={steps}
            toolCalls={toolCalls}
            messages={messages}
            childSessions={childSessions}
            onResume={(id) => resumeSession(id)}
            excludeStepId={showLiveBlock ? streamingStepId : null}
            unifiedLive
            scrollRootRef={scrollRef}
          />
        </div>
        <SessionNavigationPanel scrollRootRef={scrollRef} />
      </div>
    </div>
  )
}
