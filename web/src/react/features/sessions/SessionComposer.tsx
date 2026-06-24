import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EMPTY_INPUT_QUEUE, useAgentSessionStore } from './agentSessionStore'
import { useConfig } from '../settings/useConfig'
import { useWikiStore } from '../../state/wikiStore'
import { useLocale } from '../../../hooks/useLocale'
import { GoalComposerPill } from '../wiki/goal/GoalComposerPill'
import { buildGoalModelOptions, pickDefaultSelection } from '../wiki/goal/goalModelOptions'
import { sessionPath } from './sessionRoutes'
import {
  isSessionComposerLocked,
  sessionHasPendingPermissions,
  canEnqueueSessionInput,
} from './sessionComposerState'
import { InputQueueStrip } from './InputQueueStrip'
import type { AgentSession } from '../../../lib/api/agentRuntime'

interface Props {
  projectId: string
  session?: AgentSession
  layout?: 'footer' | 'centered'
}

export function SessionComposer({ session, projectId, layout = 'footer' }: Props) {
  const { t } = useLocale()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sendSessionMessage = useAgentSessionStore(s => s.sendSessionMessage)
  const submitOrEnqueueSessionInput = useAgentSessionStore(s => s.submitOrEnqueueSessionInput)
  const loadInputQueue = useAgentSessionStore(s => s.loadInputQueue)
  const removeQueuedInput = useAgentSessionStore(s => s.removeQueuedInput)
  const forceQueuedInput = useAgentSessionStore(s => s.forceQueuedInput)
  const sessionId = session?.id
  const queuedInputs = useAgentSessionStore(s =>
    sessionId ? (s.inputQueues[sessionId] ?? EMPTY_INPUT_QUEUE) : EMPTY_INPUT_QUEUE,
  )
  const submitSessionDraft = useAgentSessionStore(s => s.submitSessionDraft)
  const cancelSessionRun = useAgentSessionStore(s => s.cancelSessionRun)
  const refreshSessions = useAgentSessionStore(s => s.refreshSessions)
  const hasPendingPermissions = useAgentSessionStore(s =>
    sessionHasPendingPermissions(sessionId, s.selectedSessionId, s.permissions),
  )
  const isDraft = !session
  const isGenerating = isSessionComposerLocked(session, { submitting, hasPendingPermissions })
  const queueWhileGenerating = canEnqueueSessionInput(session)
  const resyncedStaleWaitingRef = useRef(false)

  useEffect(() => {
    resyncedStaleWaitingRef.current = false
  }, [sessionId])

  useEffect(() => {
    if (isDraft || !sessionId) return
    if (session?.status !== 'waiting_permission') return
    if (hasPendingPermissions) return
    if (resyncedStaleWaitingRef.current) return
    resyncedStaleWaitingRef.current = true
    void refreshSessions()
  }, [hasPendingPermissions, isDraft, refreshSessions, session?.status, sessionId])

  const { providers, globalConfig, effectiveConfig } = useConfig(projectId)
  const providerId = useWikiStore(s => s.goalComposerProviderId)
  const modelId = useWikiStore(s => s.goalComposerModelId)
  const setProviderId = useWikiStore(s => s.setGoalComposerProviderId)
  const setModelId = useWikiStore(s => s.setGoalComposerModelId)
  const permissionTier = useWikiStore(s => s.goalComposerPermissionTier)
  const setPermissionTier = useWikiStore(s => s.setGoalPermissionTier)

  useEffect(() => {
    if (!globalConfig) return
    if (providerId && modelId) return
    const { apiModels, acpEndpoints } = buildGoalModelOptions(globalConfig, providers)
    const preferred = effectiveConfig
      ? { providerId: effectiveConfig.providerId, modelId: effectiveConfig.modelId }
      : null
    const picked = pickDefaultSelection(apiModels, acpEndpoints, preferred)
    if (picked) {
      setProviderId(picked.providerId)
      setModelId(picked.modelId)
    }
  }, [globalConfig, providers, effectiveConfig, providerId, modelId, setProviderId, setModelId])

  useEffect(() => {
    if (!sessionId) return
    void loadInputQueue(sessionId)
  }, [loadInputQueue, sessionId])

  const handleSubmit = useCallback(async () => {
    const message = content.trim()
    if (!message || (isGenerating && !queueWhileGenerating)) return
    setContent('')
    setSubmitting(true)
    try {
      if (isDraft) {
        const created = await submitSessionDraft(projectId, { message, model: modelId })
        navigate(sessionPath(projectId, created.id))
        await sendSessionMessage(created.id, { message, model: modelId })
      } else {
        await submitOrEnqueueSessionInput(session.id, { message, model: modelId })
      }
    } finally {
      setSubmitting(false)
    }
  }, [content, isDraft, isGenerating, modelId, navigate, projectId, queueWhileGenerating, sendSessionMessage, session, submitSessionDraft, submitOrEnqueueSessionInput])

  const handleStop = useCallback(() => {
    if (session) void cancelSessionRun(session.id)
  }, [cancelSessionRun, session])

  const isCentered = layout === 'centered'
  const expandedShell = isCentered || content.includes('\n')

  const composer = (
    <GoalComposerPill
      content={content}
      onContentChange={setContent}
      onSubmit={() => void handleSubmit()}
      onStop={handleStop}
      isGenerating={isGenerating}
      defaultExpanded={isCentered}
      providerId={providerId}
      modelId={modelId}
      onModelSelect={(selection) => {
        setProviderId(selection.providerId)
        setModelId(selection.modelId)
      }}
      providers={providers}
      globalConfig={globalConfig}
      documentId={null}
      onDocumentChange={() => {}}
      wikiAttachMode="auto"
      onWikiAttachModeChange={() => {}}
      documents={[]}
      skillIds={[]}
      onSkillIdsChange={() => {}}
      permissionTier={permissionTier}
      onPermissionTierChange={setPermissionTier}
      disabled={isGenerating && !queueWhileGenerating}
      queueWhileGenerating={queueWhileGenerating}
    />
  )

  const composerShell = (
    <div
      className={`goal-session-composer-shell goal-dock-shell w-full flex flex-col items-center${isCentered ? ' goal-session-composer-shell--draft' : ''}`}
      data-multiline={expandedShell ? 'true' : undefined}
    >
      {sessionId && (
        <InputQueueStrip
          items={queuedInputs}
          onRemove={(itemId) => void removeQueuedInput(sessionId, itemId)}
          onForce={(itemId) => void forceQueuedInput(sessionId, itemId)}
        />
      )}
      <div className="goal-dock-shell-content">{composer}</div>
    </div>
  )

  return (
    <div
      className={
        isCentered
          ? 'flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10'
          : 'goal-session-composer shrink-0 px-4 pb-4 pt-2'
      }
    >
      {isCentered ? (
        <div className="flex w-full max-w-3xl flex-col items-center gap-6">
          <div className="max-w-lg text-center">
            <h2 className="text-lg font-medium text-foreground">{t('sessionDraftTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('sessionDraftHint')}</p>
          </div>
          <div className="w-full min-w-0">{composerShell}</div>
        </div>
      ) : (
        <div className="mx-auto w-full min-w-0 max-w-3xl">{composerShell}</div>
      )}
    </div>
  )
}
