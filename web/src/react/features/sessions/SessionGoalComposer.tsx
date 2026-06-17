import { useCallback, useEffect, useState } from 'react'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { useConfig } from '../settings/useConfig'
import { useWikiStore } from '../../state/wikiStore'
import { GoalComposerPill } from '../wiki/goal/GoalComposerPill'
import { buildGoalModelOptions, pickDefaultSelection } from '../wiki/goal/goalModelOptions'
import type { AgentSession } from '../../../lib/api/agentRuntime'

interface Props {
  session: AgentSession
  projectId: string
}

export function SessionGoalComposer({ session, projectId }: Props) {
  const [content, setContent] = useState('')
  const sendSessionMessage = useDebugConsole(s => s.sendSessionMessage)
  const cancelSessionRun = useDebugConsole(s => s.cancelSessionRun)
  const isGenerating = session.status === 'running' || session.status === 'waiting_permission'

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
    await sendSessionMessage(session.id, { message, model: modelId })
  }, [content, isGenerating, modelId, sendSessionMessage, session.id])

  const handleStop = useCallback(() => {
    void cancelSessionRun(session.id)
  }, [cancelSessionRun, session.id])

  const isMultiline = content.includes('\n')

  return (
    <div className="goal-session-composer shrink-0 px-4 pb-4 pt-2">
      <div
        className="goal-session-composer-shell goal-dock-shell mx-auto w-full max-w-3xl"
        data-multiline={isMultiline ? 'true' : undefined}
      >
        <div className="goal-dock-shell-content">
          <GoalComposerPill
            content={content}
            onContentChange={setContent}
            onSubmit={() => void handleSubmit()}
            onStop={handleStop}
            isGenerating={isGenerating}
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
        </div>
      </div>
    </div>
  )
}
