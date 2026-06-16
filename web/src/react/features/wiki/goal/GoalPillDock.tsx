import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocale } from '../../../../hooks/useLocale'
import { useConfig } from '../../settings/useConfig'
import { useWikiStore } from '../../../state/wikiStore'
import { GoalComposerPill } from './GoalComposerPill'
import { GoalDialogPanel } from './GoalDialogPanel'
import { GoalAsciiMood } from './GoalAsciiMood'
import { goalDockStateToMorph } from './goalDockTypes'
import { buildGoalModelOptions, pickDefaultSelection } from './goalModelOptions'

interface Props {
  projectId: string
}

const PHASE_LABEL_KEYS: Record<string, 'planPhaseAnalyzing' | 'planPhaseReadingSource' | 'planPhasePlanning' | 'planPhaseSubmitting'> = {
  analyzing: 'planPhaseAnalyzing',
  reading_source: 'planPhaseReadingSource',
  planning: 'planPhasePlanning',
  submitting: 'planPhaseSubmitting',
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
  const skillIds = useWikiStore(s => s.goalComposerSkillIds)
  const setSkillIds = useWikiStore(s => s.setGoalComposerSkillIds)
  const permissions = useWikiStore(s => s.goalComposerPermissions)
  const setPermission = useWikiStore(s => s.setGoalComposerPermission)
  const selectedDocumentId = useWikiStore(s => s.selectedDocumentId)
  const documents = useWikiStore(s => s.documents)
  const goals = useWikiStore(s => s.goals)
  const submitGoal = useWikiStore(s => s.submitGoal)
  const stopGoal = useWikiStore(s => s.stopGoal)
  const planGen = useWikiStore(s => s.planGeneration)

  const wasGenerating = useRef(false)
  const dockHoverRef = useRef(false)
  const dockFocusRef = useRef(false)
  const dockOverlayRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const morph = goalDockStateToMorph(goalDockState)
  const isExpanded = goalDockState === 'expanded'
  const showComposer = morph === 'pill-input' || morph === 'pill-expanded'
  const showMini = morph === 'mini'
  const hasPendingGoals = goals.length > 0
  const latestTool = planGen.toolCalls[planGen.toolCalls.length - 1]

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const tryCloseInput = useCallback(() => {
    if (dockHoverRef.current || dockFocusRef.current || dockOverlayRef.current) return
    if (goalDockState === 'input') setGoalDockState('idle')
  }, [goalDockState, setGoalDockState])

  const handleOverlayOpenChange = useCallback((open: boolean) => {
    dockOverlayRef.current = open
    if (open) {
      clearCloseTimer()
      dockFocusRef.current = true
      return
    }
    window.setTimeout(() => {
      const root = document.querySelector('.goal-dock-zone')
      const active = document.activeElement
      if (active && root?.contains(active)) {
        dockFocusRef.current = true
        return
      }
      dockFocusRef.current = false
      tryCloseInput()
    }, 0)
  }, [clearCloseTimer, tryCloseInput])

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
    if (documentId === null && selectedDocumentId) {
      setDocumentId(selectedDocumentId)
    }
  }, [documentId, selectedDocumentId, setDocumentId])

  useEffect(() => {
    if (planGen.status === 'generating') {
      wasGenerating.current = true
      if (goalDockState === 'input') setGoalDockState('working')
    }
    if (wasGenerating.current && planGen.status === 'idle') {
      wasGenerating.current = false
      if (goalDockState === 'working' || goalDockState === 'expanded') {
        setGoalDockState('idle')
      }
    }
    if (planGen.status === 'failed' && goalDockState === 'working') {
      setGoalDockState('expanded')
    }
  }, [planGen.status, goalDockState, setGoalDockState])

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

  const openInput = useCallback(() => {
    if (goalDockState === 'working' || goalDockState === 'expanded') return
    if (planGen.status === 'generating') return
    setGoalDockState('input')
  }, [goalDockState, planGen.status, setGoalDockState])

  const handleDockEnter = useCallback(() => {
    clearCloseTimer()
    dockHoverRef.current = true
    openInput()
  }, [clearCloseTimer, openInput])

  const handleDockLeave = useCallback(() => {
    dockHoverRef.current = false
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      tryCloseInput()
    }, 120)
  }, [clearCloseTimer, tryCloseInput])

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
      tryCloseInput()
    }, 0)
  }, [tryCloseInput])

  useEffect(() => {
    if (!isExpanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGoalDockState('working')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isExpanded, setGoalDockState])

  const phaseLabel = planGen.phase && PHASE_LABEL_KEYS[planGen.phase]
    ? t(PHASE_LABEL_KEYS[planGen.phase])
    : t('goalPlanning')

  return (
    <>
      {isExpanded && (
        <div
          className="pointer-events-none absolute inset-0 z-20 bg-background/25 backdrop-blur-[1px]"
          aria-hidden="true"
        />
      )}

      <div
        className="goal-dock-zone absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-3 pt-24"
        onMouseEnter={handleDockEnter}
        onMouseLeave={handleDockLeave}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        <div
          className="goal-dock-morph flex w-full max-w-[26.25rem] flex-col items-center"
          data-morph={morph}
        >
          {isExpanded && (
            <div className="goal-dock-dialog-slot mb-2.5 w-full">
              <GoalDialogPanel
                statusLabel={phaseLabel}
                toolCalls={planGen.toolCalls}
                phase={planGen.phase}
                error={planGen.error}
                onOpenSession={() => {
                  const sessionId = planGen.sessionId
                  if (sessionId) {
                    navigate(`/projects/${projectId}/sessions?session=${sessionId}`)
                  } else {
                    navigate(`/projects/${projectId}/sessions`)
                  }
                }}
              />
            </div>
          )}

          <div
            className={`goal-dock-shell${hasPendingGoals ? ' goal-dock-shell--pending' : ''}`}
            data-shell={morph}
          >
            {showMini && (
              <button
                type="button"
                className="goal-dock-mini-inner flex h-full w-full items-center gap-2 px-3 text-[11px] transition-transform active:scale-[0.98]"
                onClick={() => setGoalDockState('expanded')}
                aria-label={t('goalExpandSession')}
              >
                <GoalAsciiMood />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {latestTool ? (
                    <>
                      <span className="font-medium text-foreground">{latestTool.tool}</span>
                      {' '}
                      {latestTool.summary}
                    </>
                  ) : (
                    t('goalWorking')
                  )}
                </span>
                <span className="text-[9px] text-muted-foreground/40">▲</span>
              </button>
            )}

            {showComposer && (
              <div className="goal-dock-shell-content">
                <GoalComposerPill
                  content={content}
                  onContentChange={setContent}
                  onSubmit={() => void submitGoal(projectId)}
                  onStop={stopGoal}
                  isGenerating={planGen.status === 'generating'}
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
                  documents={documents}
                  skillIds={skillIds}
                  onSkillIdsChange={setSkillIds}
                  permissions={permissions}
                  onPermissionChange={setPermission}
                  disabled={planGen.status === 'generating'}
                  onOverlayOpenChange={handleOverlayOpenChange}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
