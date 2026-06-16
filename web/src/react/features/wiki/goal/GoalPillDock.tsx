import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocale } from '../../../../hooks/useLocale'
import { useConfig } from '../../settings/useConfig'
import { useWikiStore } from '../../../state/wikiStore'
import { GoalComposerPill } from './GoalComposerPill'
import { GoalDialogPanel } from './GoalDialogPanel'
import { GoalMiniPill } from './GoalMiniPill'
import { GoalPromptPill } from './GoalPromptPill'
import { GoalPreviewPill } from './GoalPreviewPill'
import { goalDockStateToMorph } from './goalDockTypes'
import { buildGoalModelOptions, pickDefaultSelection } from './goalModelOptions'
import { isGoalSessionActive } from './goalSessionStream'
import { useGoalSessionBridge } from './useGoalSessionBridge'

interface Props {
  projectId: string
}

export function GoalPillDock({ projectId }: Props) {
  const { t } = useLocale()
  const navigate = useNavigate()
  const { providers, globalConfig, effectiveConfig } = useConfig(projectId)

  const goalDockState = useWikiStore(s => s.goalDockState)
  const setGoalDockState = useWikiStore(s => s.setGoalDockState)
  const content = useWikiStore(s => s.goalComposerContent)
  const setContent = useWikiStore(s => s.setGoalComposerContent)
  const providerId = useWikiStore(s => s.goalComposerProviderId)
  const setProviderId = useWikiStore(s => s.setGoalComposerProviderId)
  const modelId = useWikiStore(s => s.goalComposerModelId)
  const setModelId = useWikiStore(s => s.setGoalComposerModelId)
  const documentId = useWikiStore(s => s.goalComposerDocumentId)
  const setDocumentId = useWikiStore(s => s.setGoalComposerDocumentId)
  const wikiAttachMode = useWikiStore(s => s.goalComposerWikiAttachMode)
  const setWikiAttachMode = useWikiStore(s => s.setGoalComposerWikiAttachMode)
  const skillIds = useWikiStore(s => s.goalComposerSkillIds)
  const setSkillIds = useWikiStore(s => s.setGoalComposerSkillIds)
  const permissions = useWikiStore(s => s.goalComposerPermissions)
  const setPermission = useWikiStore(s => s.setGoalComposerPermission)
  const documents = useWikiStore(s => s.documents)
  const goals = useWikiStore(s => s.goals)
  const submitGoal = useWikiStore(s => s.submitGoal)
  const stopGoal = useWikiStore(s => s.stopGoal)
  const replyGoalPermission = useWikiStore(s => s.replyGoalPermission)
  const goalSession = useWikiStore(s => s.goalSession)

  useGoalSessionBridge(projectId)

  const [miniHovered, setMiniHovered] = useState(false)
  const dockHoverRef = useRef(false)
  const dockFocusRef = useRef(false)
  const dockOverlayRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hitRef = useRef<HTMLDivElement>(null)

  const morph = goalDockStateToMorph(goalDockState)
  const isBar = goalDockState === 'idle'
  const isPrompt = goalDockState === 'prompt'
  const isMini = goalDockState === 'working'
  const isCompose = goalDockState === 'input'
  const isChat = goalDockState === 'expanded'

  const hasActiveWork = isGoalSessionActive(goalSession.status)
  const hasSession = Boolean(goalSession.sessionId) && goalSession.status !== 'idle'
  const hasPendingGoals = goals.length > 0
  const latestTool = goalSession.toolCalls[goalSession.toolCalls.length - 1]
  const isGenerating = goalSession.status === 'running'
  const isWaitingPermission = goalSession.status === 'waiting_permission'

  const sessionStatusLabel =
    goalSession.status === 'completed' ? t('goalCompleted')
      : goalSession.status === 'failed' ? t('goalFailed')
        : isWaitingPermission ? t('goalWaitingApproval')
          : t('goalWorking')

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const collapseCompose = useCallback(() => {
    if (dockHoverRef.current || dockFocusRef.current || dockOverlayRef.current) return
    if (isChat) {
      setGoalDockState(hasActiveWork ? 'working' : 'idle')
      return
    }
    if (isCompose || isPrompt) {
      setGoalDockState('idle')
    }
  }, [hasActiveWork, isChat, isCompose, isPrompt, setGoalDockState])

  const handleOverlayOpenChange = useCallback((open: boolean) => {
    dockOverlayRef.current = open
    if (open) {
      clearCloseTimer()
      dockFocusRef.current = true
      return
    }
    window.setTimeout(() => {
      const root = hitRef.current
      const active = document.activeElement
      if (active && root?.contains(active)) {
        dockFocusRef.current = true
        return
      }
      dockFocusRef.current = false
      collapseCompose()
    }, 0)
  }, [clearCloseTimer, collapseCompose])

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
    if (hasActiveWork && (isBar || isPrompt)) {
      setGoalDockState('working')
    }
  }, [hasActiveWork, isBar, isPrompt, setGoalDockState])

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

  const settleToBarIfIdle = useCallback(() => {
    if (hasActiveWork || isChat || isCompose) return
    if (dockHoverRef.current || miniHovered) return
    if (goalDockState === 'working' || goalDockState === 'prompt') {
      setGoalDockState('idle')
    }
  }, [hasActiveWork, isChat, isCompose, goalDockState, miniHovered, setGoalDockState])

  useEffect(() => {
    settleToBarIfIdle()
  }, [hasActiveWork, goalDockState, miniHovered, settleToBarIfIdle])

  const handleMiniLeave = useCallback(() => {
    setMiniHovered(false)
    window.setTimeout(() => settleToBarIfIdle(), 0)
  }, [settleToBarIfIdle])

  const openPromptFromBar = useCallback(() => {
    if (!isBar || hasActiveWork) return
    setGoalDockState('prompt')
  }, [hasActiveWork, isBar, setGoalDockState])

  const handleBarEnter = useCallback(() => {
    clearCloseTimer()
    dockHoverRef.current = true
    openPromptFromBar()
  }, [clearCloseTimer, openPromptFromBar])

  const handlePromptOrComposeEnter = useCallback(() => {
    clearCloseTimer()
    dockHoverRef.current = true
  }, [clearCloseTimer])

  const handleLeave = useCallback(() => {
    dockHoverRef.current = false
    setMiniHovered(false)
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      collapseCompose()
    }, 120)
  }, [clearCloseTimer, collapseCompose])

  const handleFocusCapture = useCallback(() => {
    clearCloseTimer()
    dockFocusRef.current = true
  }, [clearCloseTimer])

  const handleBlurCapture = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const root = e.currentTarget
    const related = e.relatedTarget as Node | null
    if (related && root.contains(related)) return

    window.setTimeout(() => {
      const active = document.activeElement
      if (active && root.contains(active)) return
      if (active?.closest('[role="menu"], [role="listbox"]')) {
        dockFocusRef.current = true
        return
      }
      if (dockOverlayRef.current) return
      dockFocusRef.current = false
      collapseCompose()
    }, 0)
  }, [collapseCompose])

  useEffect(() => {
    if (!isChat) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGoalDockState(hasActiveWork ? 'working' : 'idle')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isChat, hasActiveWork, setGoalDockState])

  const openSessionPage = useCallback(() => {
    const sessionId = goalSession.sessionId
    if (sessionId) {
      navigate(`/projects/${projectId}/sessions?session=${sessionId}`)
    } else {
      navigate(`/projects/${projectId}/sessions`)
    }
  }, [goalSession.sessionId, navigate, projectId])

  const hitMode = isChat
    ? 'dialog'
    : isCompose
      ? (hasSession ? 'composer-active' : 'composer')
      : isPrompt || isMini
        ? 'mini'
        : 'bar'

  const composer = (
    <GoalComposerPill
      content={content}
      onContentChange={setContent}
      onSubmit={() => void submitGoal(projectId)}
      onStop={stopGoal}
      isGenerating={isGenerating}
      providerId={providerId}
      modelId={modelId}
      onModelSelect={(selection) => {
        setProviderId(selection.providerId)
        setModelId(selection.modelId)
      }}
      providers={providers}
      globalConfig={globalConfig}
      documentId={documentId}
      onDocumentChange={setDocumentId}
      wikiAttachMode={wikiAttachMode}
      onWikiAttachModeChange={setWikiAttachMode}
      documents={documents}
      skillIds={skillIds}
      onSkillIdsChange={setSkillIds}
      permissions={permissions}
      onPermissionChange={setPermission}
      disabled={isGenerating}
      onOverlayOpenChange={handleOverlayOpenChange}
    />
  )

  return (
    <>
      {isChat && (
        <div
          className="pointer-events-none absolute inset-0 z-20 bg-background/25 backdrop-blur-[1px]"
          aria-hidden="true"
        />
      )}

      <div className="goal-dock-zone absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-3">
        <div
          ref={hitRef}
          className="goal-dock-hit"
          data-hit={hitMode}
          onMouseEnter={isBar ? handleBarEnter : isPrompt || isCompose || isChat ? handlePromptOrComposeEnter : undefined}
          onMouseLeave={isBar || isPrompt || isCompose || isChat ? handleLeave : undefined}
          onFocusCapture={isCompose || isChat ? handleFocusCapture : undefined}
          onBlurCapture={isCompose || isChat ? handleBlurCapture : undefined}
        >
          <div className="goal-dock-morph flex flex-col items-center" data-morph={morph}>
            {isChat && (
              <div className="goal-dock-dialog-slot mb-2.5 w-full">
                <GoalDialogPanel
                  statusLabel={sessionStatusLabel}
                  toolCalls={goalSession.toolCalls}
                  permissions={goalSession.permissions}
                  thinking={goalSession.streamingThinking}
                  streamingText={goalSession.streamingText}
                  isRunning={isGenerating}
                  isWaitingPermission={isWaitingPermission}
                  error={goalSession.error}
                  onOpenSession={openSessionPage}
                  onReplyPermission={(id, reply) => void replyGoalPermission(id, reply)}
                />
              </div>
            )}

            <div className="goal-dock-stack flex w-full flex-col items-center">
              {isCompose && hasSession && (
                <GoalPreviewPill
                  status={goalSession.status}
                  latestTool={latestTool}
                  thinkingPreview={goalSession.streamingThinking}
                  statusLabel={sessionStatusLabel}
                  onClick={() => setGoalDockState('expanded')}
                />
              )}

              <div
                className={`goal-dock-shell w-full${hasPendingGoals && isBar ? ' goal-dock-shell--pending' : ''}`}
                data-shell={morph}
              >
                {isPrompt && (
                  <GoalPromptPill
                    label={t('goalSoulPrompt')}
                    hovered={miniHovered}
                    onClick={() => setGoalDockState('input')}
                    onMouseEnter={() => setMiniHovered(true)}
                    onMouseLeave={() => setMiniHovered(false)}
                  />
                )}

                {isMini && (
                  <GoalMiniPill
                    status={goalSession.status}
                    toolCalls={goalSession.toolCalls}
                    thinking={goalSession.streamingThinking}
                    statusLabel={sessionStatusLabel}
                    hovered={miniHovered}
                    onClick={() => setGoalDockState('expanded')}
                    onMouseEnter={() => setMiniHovered(true)}
                    onMouseLeave={handleMiniLeave}
                  />
                )}

                {(isCompose || isChat) && (
                  <div className="goal-dock-shell-content">
                    {composer}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
