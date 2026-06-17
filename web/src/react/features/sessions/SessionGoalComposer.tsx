import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import { useConfig } from '../settings/useConfig'
import { useWikiStore } from '../../state/wikiStore'
import { useLocale } from '../../../hooks/useLocale'
import { GoalComposerPill } from '../wiki/goal/GoalComposerPill'
import { buildGoalModelOptions, pickDefaultSelection } from '../wiki/goal/goalModelOptions'
import { goalSessionPath } from './sessionRoutes'
import type { AgentSession } from '../../../lib/api/agentRuntime'

interface Props {
  projectId: string
  session?: AgentSession
  layout?: 'footer' | 'centered'
}

export function SessionGoalComposer({ session, projectId, layout = 'footer' }: Props) {
  const { t } = useLocale()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sendSessionMessage = useAgentSessionStore(s => s.sendSessionMessage)
  const submitGoalDraft = useAgentSessionStore(s => s.submitGoalDraft)
  const cancelSessionRun = useAgentSessionStore(s => s.cancelSessionRun)
  const isDraft = !session
  const isGenerating =
    submitting
    || (!isDraft && session.status === 'waiting_permission')
    || (!isDraft && session.status === 'running' && Boolean(session.activeRunId))

  const { providers, globalConfig, effectiveConfig } = useConfig(projectId)
  const providerId = useWikiStore(s => s.goalComposerProviderId)
  const modelId = useWikiStore(s => s.goalComposerModelId)
  const setProviderId = useWikiStore(s => s.setGoalComposerProviderId)
  const setModelId = useWikiStore(s => s.setGoalComposerModelId)
  const composerPermissions = useWikiStore(s => s.goalComposerPermissions)
  const setPermissionPreset = useWikiStore(s => s.setGoalPermissionPreset)

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

  const handleSubmit = useCallback(async () => {
    const message = content.trim()
    if (!message || isGenerating) return
    setContent('')
    setSubmitting(true)
    try {
      if (isDraft) {
        const created = await submitGoalDraft(projectId, { message, model: modelId })
        navigate(goalSessionPath(projectId, created.id))
        await sendSessionMessage(created.id, { message, model: modelId })
      } else {
        await sendSessionMessage(session.id, { message, model: modelId })
      }
    } finally {
      setSubmitting(false)
    }
  }, [content, isDraft, isGenerating, modelId, navigate, projectId, sendSessionMessage, session, submitGoalDraft])

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
      permissions={composerPermissions}
      onPermissionPresetChange={setPermissionPreset}
      disabled={isGenerating}
    />
  )

  const composerShell = (
    <div
      className={`goal-session-composer-shell goal-dock-shell w-full${isCentered ? ' goal-session-composer-shell--draft' : ''}`}
      data-multiline={expandedShell ? 'true' : undefined}
    >
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
