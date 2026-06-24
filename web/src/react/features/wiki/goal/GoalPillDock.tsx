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
import { listPendingGoalPermissions } from './GoalQuickApproval'
import { goalDockStateToMorph } from './goalDockTypes'
import { buildGoalModelOptions, pickDefaultSelection } from './goalModelOptions'
import { isGoalSessionActive, resolveGoalSessionDisplayTitle } from './goalSessionStream'
import { useGoalSessionBridge } from './useGoalSessionBridge'
import { EMPTY_INPUT_QUEUE, useAgentSessionStore } from '../../sessions/agentSessionStore'
import { sessionPath } from '../../sessions/sessionRoutes'
import { resolveSessionsEntryPath } from '../../sessions/sessionLastVisit'
import { InputQueueStrip } from '../../sessions/InputQueueStrip'

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
  const permissionTier = useWikiStore(s => s.goalComposerPermissionTier)
  const setPermissionTier = useWikiStore(s => s.setGoalPermissionTier)
  const documents = useWikiStore(s => s.documents)
  const goals = useWikiStore(s => s.goals)
  const submitGoal = useWikiStore(s => s.submitGoal)
  const stopGoal = useWikiStore(s => s.stopGoal)
  const replyGoalPermission = useWikiStore(s => s.replyGoalPermission)
  const goalSession = useWikiStore(s => s.goalSession)
  const loadInputQueue = useAgentSessionStore(s => s.loadInputQueue)
  const removeQueuedInput = useAgentSessionStore(s => s.removeQueuedInput)
  const forceQueuedInput = useAgentSessionStore(s => s.forceQueuedInput)
  const queuedInputs = useAgentSessionStore(s =>
    goalSession.sessionId
      ? (s.inputQueues[goalSession.sessionId] ?? EMPTY_INPUT_QUEUE)
      : EMPTY_INPUT_QUEUE,
  )

  useGoalSessionBridge(projectId)

  useEffect(() => {
    if (!goalSession.sessionId) return
    void loadInputQueue(goalSession.sessionId)
  }, [goalSession.sessionId, loadInputQueue])

  const [miniHovered, setMiniHovered] = useState(false)
  const dockOverlayRef = useRef(false)
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
  const queueWhileGenerating = Boolean(goalSession.sessionId)
    && (goalSession.status === 'running' || goalSession.status === 'waiting_permission')

  const sessionDisplayTitle = resolveGoalSessionDisplayTitle(goalSession, t('goalWorking'))
  const pendingPermissions = listPendingGoalPermissions(goalSession.permissions)
  const hasPendingApproval = pendingPermissions.length > 0
  const isComposerMultiline = content.includes('\n')
  const isDismissible = isChat || isCompose || isPrompt

  const handleReplyPermission = useCallback(
    (permissionId: string, reply: 'once' | 'always' | 'reject') => {
      void replyGoalPermission(permissionId, reply)
    },
    [replyGoalPermission],
  )

  const dismissDock = useCallback(() => {
    if (dockOverlayRef.current) return
    const root = hitRef.current
    const active = document.activeElement
    if (active instanceof HTMLElement && root?.contains(active)) {
      active.blur()
    }
    if (isChat) {
      setGoalDockState(hasActiveWork ? 'working' : 'idle')
      return
    }
    if (isCompose || isPrompt) {
      setGoalDockState('idle')
    }
  }, [hasActiveWork, isChat, isCompose, isPrompt, setGoalDockState])

  const isOutsideDismissTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) return false
    const root = hitRef.current
    if (!root || root.contains(target)) return false
    const el = target instanceof Element ? target : target.parentElement
    if (el?.closest('[role="menu"], [role="listbox"], [data-slot="popover"]')) return false
    return true
  }, [])

  const handleOverlayOpenChange = useCallback((open: boolean) => {
    dockOverlayRef.current = open
  }, [])

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

  const openPromptFromBar = useCallback(() => {
    if (!isBar || hasActiveWork) return
    setGoalDockState('prompt')
  }, [hasActiveWork, isBar, setGoalDockState])

  const handleBarEnter = useCallback(() => {
    openPromptFromBar()
  }, [openPromptFromBar])

  useEffect(() => {
    if (!isDismissible) return
    const onPointerDown = (e: PointerEvent) => {
      if (!isOutsideDismissTarget(e.target)) return
      dismissDock()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isDismissible, dismissDock, isOutsideDismissTarget])

  useEffect(() => {
    if (!isDismissible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (isChat) {
        setGoalDockState(hasActiveWork ? 'working' : 'idle')
      } else {
        setGoalDockState('idle')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDismissible, isChat, hasActiveWork, setGoalDockState])

  const openSessionPage = useCallback(() => {
    const sessionId = goalSession.sessionId
    if (sessionId) {
      navigate(sessionPath(projectId, sessionId))
    } else {
      navigate(resolveSessionsEntryPath(projectId))
    }
  }, [goalSession.sessionId, navigate, projectId])

  const hitMode = isChat
    ? 'dialog'
    : isCompose
      ? (hasSession ? 'composer-active' : 'composer')
      : isPrompt || isMini
        ? 'mini'
        : 'bar'

  const showContextDialog = isChat || (isCompose && hasPendingApproval && hasSession)

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
      permissionTier={permissionTier}
      onPermissionTierChange={setPermissionTier}
      disabled={isGenerating && !queueWhileGenerating}
      queueWhileGenerating={queueWhileGenerating}
      onOverlayOpenChange={handleOverlayOpenChange}
    />
  )

  return (
    <>
      {isChat && (
        <div
          className="absolute inset-0 z-20 bg-background/25 backdrop-blur-[1px]"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault()
            dismissDock()
          }}
        />
      )}

      <div className="goal-dock-zone absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-3 sm:px-6">
        <div
          ref={hitRef}
          className="goal-dock-hit"
          data-hit={hitMode}
          onMouseEnter={isBar ? handleBarEnter : undefined}
        >
          <div
            className="goal-dock-morph flex flex-col items-center"
            data-morph={morph}
            data-awaiting-permission={hasPendingApproval ? 'true' : undefined}
          >
            {showContextDialog && (
              <div className="goal-dock-dialog-slot mb-2.5 w-full">
                <GoalDialogPanel
                  status={goalSession.status}
                  sessionTitle={sessionDisplayTitle}
                  toolCalls={goalSession.toolCalls}
                  thinking={goalSession.streamingThinking}
                  streamingText={goalSession.streamingText}
                  isRunning={isGenerating}
                  error={goalSession.error}
                  permissions={goalSession.permissions}
                  onReplyPermission={handleReplyPermission}
                  onOpenSession={isChat ? openSessionPage : undefined}
                />
              </div>
            )}

            <div className="goal-dock-stack flex w-full flex-col items-center">
              {isCompose && hasSession && !hasPendingApproval && (
                <GoalPreviewPill
                  status={goalSession.status}
                  latestTool={latestTool}
                  thinkingPreview={goalSession.streamingThinking}
                  sessionTitle={sessionDisplayTitle}
                  onClick={() => setGoalDockState('expanded')}
                />
              )}

              {goalSession.sessionId && (isCompose || isChat) && (
                <InputQueueStrip
                  items={queuedInputs}
                  onRemove={(itemId) => void removeQueuedInput(goalSession.sessionId!, itemId)}
                  onForce={(itemId) => void forceQueuedInput(goalSession.sessionId!, itemId)}
                />
              )}

              <div
                className={`goal-dock-shell w-full${hasPendingGoals && isBar ? ' goal-dock-shell--pending' : ''}`}
                data-shell={morph}
                data-multiline={(isCompose || isChat) && isComposerMultiline ? 'true' : undefined}
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
                    sessionTitle={sessionDisplayTitle}
                    permissions={goalSession.permissions}
                    onReplyPermission={handleReplyPermission}
                    hovered={miniHovered}
                    onClick={() => setGoalDockState('expanded')}
                    onMouseEnter={() => setMiniHovered(true)}
                    onMouseLeave={() => setMiniHovered(false)}
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
