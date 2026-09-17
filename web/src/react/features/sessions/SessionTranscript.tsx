import { useLocale } from '../../../hooks/useLocale'
import { useTranscriptScroll } from './useTranscriptScroll'
import { useRef } from 'react'
import { Skeleton } from '@heroui/react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'
import { SessionNavigationPanel } from './SessionNavigationPanel'

function useSessionTranscriptStatic() {
  return useAgentSessionStore(
    useShallow((s) => {
      const id = s.selectedSessionId
      return {
        sessionId: id,
        loading: s.detailLoading,
        error: s.detailError,
        session: id ? s.sessions.find((ss) => ss.id === id) : undefined,
        runs: s.runs,
        steps: s.steps,
        toolCalls: s.toolCalls,
        messages: s.messages,
        childSessions: id ? s.childSessions[id] : undefined,
        streamingStepId: s.streamingStepId,
      }
    }),
  )
}

export function SessionTranscript({
  onReadingHistoryChange,
  active = true,
}: {
  active?: boolean
  onReadingHistoryChange?: (reading: boolean) => void
}) {
  const { locale } = useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    session,
    sessionId,
    loading,
    error,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
  } = useSessionTranscriptStatic()

  const streamingStep = streamingStepId ? steps.find((s) => s.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')

  useTranscriptScroll(
    scrollRef,
    sessionId ?? undefined,
    onReadingHistoryChange,
    active && (!loading || showLiveBlock),
  )

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label={locale === 'zh' ? '对话记录' : 'Conversation history'}
          className="session-chat-scroll h-full overflow-y-auto"
          aria-busy={loading}
        >
          <div className="session-transcript-body">
            {loading && messages.length === 0 && !showLiveBlock ? (
              <div
                role="status"
                className="session-transcript-skeleton mx-auto w-full max-w-3xl space-y-6 px-[1.2rem] py-4"
              >
                <span className="sr-only">{locale === 'zh' ? '正在加载对话' : 'Loading conversation'}</span>
                <Skeleton className="ml-auto h-16 w-2/3 rounded-xl" />
                <Skeleton className="h-4 w-3/4 rounded-lg" />
                <Skeleton className="h-4 w-full rounded-lg" />
                <Skeleton className="h-4 w-1/2 rounded-lg" />
                <Skeleton className="mt-8 h-24 w-3/4 rounded-xl" />
              </div>
            ) : error && messages.length === 0 && !showLiveBlock ? (
              <div role="alert" className="p-6 text-center text-sm text-muted-foreground">
                <p>{locale === 'zh' ? '对话加载失败，请重试' : 'Could not load conversation'}</p>
                <button
                  type="button"
                  className="mt-3 underline"
                  onClick={() => void useAgentSessionStore.getState().refreshDetail()}
                >
                  {locale === 'zh' ? '重试' : 'Retry'}
                </button>
              </div>
            ) : (
              <AgentConversationView
                session={session}
                runs={runs}
                steps={steps}
                toolCalls={toolCalls}
                messages={messages}
                childSessions={childSessions}
                excludeStepId={showLiveBlock ? streamingStepId : null}
                unifiedLive={active}
                scrollRootRef={scrollRef}
              />
            )}
          </div>
        </div>
        {active && <SessionNavigationPanel scrollRootRef={scrollRef} />}
      </div>
    </div>
  )
}
