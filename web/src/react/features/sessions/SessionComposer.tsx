import { NativeBackendModelPicker } from './NativeBackendModelPicker'
import { RuntimeRecoveryPanel } from './RuntimeRecoveryPanel'
import { agentRuntimeApi, type BackendId } from '../../../lib/api/agentRuntime'
import { SessionBackendPicker } from './SessionBackendPicker'
import { readSessionBackendId } from './synaxSessionTypes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EMPTY_INPUT_QUEUE, useAgentSessionStore } from './agentSessionStore'
import { useConfig } from '../settings/useConfig'
import { useWikiStore } from '../../state/wikiStore'
import { useLocale } from '../../../hooks/useLocale'
import { goalApi } from '../../../lib/api/goal'
import { GoalComposerPill } from '../wiki/goal/GoalComposerPill'
import { buildGoalModelOptions, formatTurnModel, pickDefaultSelection } from '../wiki/goal/goalModelOptions'
import { prefetchAcpDiscoveryIdle } from '../wiki/goal/useAcpDiscovery'
import { sessionPath } from './sessionRoutes'
import {
  isSessionComposerLocked,
  sessionHasPendingPermissions,
  canEnqueueSessionInput,
  canSwitchSessionMode,
} from './sessionComposerState'
import { InputQueueStrip } from './InputQueueStrip'
import type { AgentSession, AgentSessionMode, ReasoningEffort } from '../../../lib/api/agentRuntime'
import { AgentInteractionPanel } from './AgentInteractionPanel'
import { SessionModePicker } from './SessionModePicker'
import { effectiveReasoningEfforts } from '../settings/lib/providerPresets'
import {
  readSynaxDocumentId,
  readSynaxPermissionTier,
  readSynaxWikiAttachMode,
  readSynaxSessionMode,
  isAcpSession,
  type SynaxPermissionTier,
} from './synaxSessionTypes'

interface Props {
  projectId: string
  session?: AgentSession
  layout?: 'footer' | 'centered' | 'focusRail'
  /** Rendered directly above the input pill (e.g. the file-change island). */
  statusSlot?: React.ReactNode
}

export function SessionComposer({ session, projectId, layout = 'footer', statusSlot }: Props) {
  const { t, locale } = useLocale()
  const zh = locale === 'zh'
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [changingMode, setChangingMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftMode = useAgentSessionStore(s => s.draftMode)
  const setDraftMode = useAgentSessionStore(s => s.setDraftMode)
  const updateSessionMode = useAgentSessionStore(s => s.updateSessionMode)
  const interactionState = useAgentSessionStore(s => s.interactionState)
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
  const currentInteractions = interactionState?.sessionId === sessionId ? interactionState : null
  const pendingInteractions = currentInteractions?.items.filter(item => item.status === 'pending') ?? []
  const hasPendingInteractions = pendingInteractions.length > 0
  const onlyPlanApprovalPending = Boolean(currentInteractions && !currentInteractions.loading && !currentInteractions.error
    && pendingInteractions.length > 0 && pendingInteractions.every(item => item.kind === 'plan_approval'))
  const isGenerating = isSessionComposerLocked(session, {
    submitting,
    hasPendingPermissions,
    hasPendingInteractions: hasPendingInteractions && !onlyPlanApprovalPending,
    allowWaitingInputForPlanApproval: onlyPlanApprovalPending,
  })
  const queueWhileGenerating = !hasPendingInteractions && canEnqueueSessionInput(session)
  const resyncedStaleWaitingRef = useRef(false)

  useEffect(() => {
    resyncedStaleWaitingRef.current = false
    setError(null)
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
  const [draftBackendId, setDraftBackendId] = useState<BackendId>(() => {
    const previous = useWikiStore.getState().goalComposerProviderId
    return previous?.endsWith('-acp') ? previous as BackendId : 'native'
  })
  const backendId = session ? readSessionBackendId(session) : draftBackendId
  const [backendCatalog, setBackendCatalog] = useState<Array<{ id: BackendId; label: string; kind: string; experimental?: boolean }>>([])
  const [cliModel, setCliModel] = useState<string>('default')
  const [cliEfforts, setCliEfforts] = useState<ReasoningEffort[] | undefined>()
  const cliBackend = backendId === 'codex' || backendId === 'claude-code'
  const backendOptions = [{ id: 'native' as BackendId, label: 'Synax Native' },
    ...backendCatalog.filter(backend => backend.kind === 'cli').map(backend => ({ id: backend.id, label: `${backend.label}${backend.experimental ? ' · Preview' : ''}` })),
    ...providers.filter(provider => provider.kind === 'acp').map(provider => ({ id: provider.id as BackendId, label: provider.label ?? provider.id }))]
  useEffect(() => {
    let active = true
    void agentRuntimeApi.listBackends().then(result => { if (active) setBackendCatalog(result.items) }).catch(() => { if (active) setError(zh ? '无法读取执行后端目录，请检查 Runtime 连接。' : 'Cannot load backends. Check the Runtime connection.') })
    return () => { active = false }
  }, [zh])
  useEffect(() => {
    const metadata = session?.sessionMetadata
    const native = metadata?.nativeBackend as { model?: string } | undefined
    const binding = metadata?.backend as { model?: string } | undefined
    setCliModel(native?.model || binding?.model || 'default')
    setCliEfforts(undefined)
  }, [session?.id, backendId])

  const providerId = useWikiStore(s => s.goalComposerProviderId)
  const modelId = useWikiStore(s => s.goalComposerModelId)
  const setProviderId = useWikiStore(s => s.setGoalComposerProviderId)
  const setModelId = useWikiStore(s => s.setGoalComposerModelId)
  const reasoningEffort = useWikiStore(s => s.goalComposerReasoningEffort)
  const setReasoningEffort = useWikiStore(s => s.setGoalComposerReasoningEffort)
  const permissionTier = useWikiStore(s => s.goalComposerPermissionTier)
  const wikiAttachMode = useWikiStore(s => s.goalComposerWikiAttachMode)
  const setWikiAttachMode = useWikiStore(s => s.setGoalComposerWikiAttachMode)
  const documentId = useWikiStore(s => s.goalComposerDocumentId)
  const setDocumentId = useWikiStore(s => s.setGoalComposerDocumentId)
  const documents = useWikiStore(s => s.documents)
  const loadProjectSnapshot = useWikiStore(s => s.loadProjectSnapshot)
  const updateSessionPermissions = useAgentSessionStore(s => s.updateSessionPermissions)
  const acp = backendId !== 'native'
  const mode = isDraft ? (acp ? 'chat' : draftMode) : readSynaxSessionMode(session.sessionMetadata)
  const modeEnabled = !submitting && !changingMode && canSwitchSessionMode(session, {
    acp,
    hasPendingPermissions,
    hasPendingInteractions: Boolean(session && (!currentInteractions || currentInteractions.loading || currentInteractions.error || hasPendingInteractions)),
  })
  const incompatibleModel = backendId === 'native' && Boolean(providerId?.endsWith('-acp'))

  const handleModeChange = async (next: AgentSessionMode) => {
    if (!modeEnabled) return
    setError(null)
    if (isDraft) {
      setDraftMode(next)
      return
    }
    setChangingMode(true)
    try {
      await updateSessionMode(session.id, next)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingMode(false)
    }
  }

  useEffect(() => {
    if (!projectId) return
    void loadProjectSnapshot(projectId)
  }, [loadProjectSnapshot, projectId])

  useEffect(() => {
    if (!session) return
    const tier = readSynaxPermissionTier(session.sessionMetadata)
    // Local-only sync — do not call setGoalPermissionTier (it PATCHes goalSession and loops).
    if (useWikiStore.getState().goalComposerPermissionTier === tier) return
    useWikiStore.setState({ goalComposerPermissionTier: tier })
  }, [session?.id, session?.sessionMetadata])

  const handlePermissionTierChange = useCallback((tier: SynaxPermissionTier) => {
    if (useWikiStore.getState().goalComposerPermissionTier !== tier) {
      useWikiStore.setState({ goalComposerPermissionTier: tier })
    }
    if (sessionId) {
      void updateSessionPermissions(sessionId, { permissionTier: tier })
    }
  }, [sessionId, updateSessionPermissions])

  useEffect(() => {
    prefetchAcpDiscoveryIdle()
  }, [])

  useEffect(() => {
    if (!session) return
    const stored = session.reasoningEffort ?? null
    const current = useWikiStore.getState().goalComposerReasoningEffort
    const next: ReasoningEffort = stored ?? 'high'
    if (current !== next) {
      useWikiStore.setState({ goalComposerReasoningEffort: next })
    }
  }, [session?.id, session?.reasoningEffort])

  useEffect(() => {
    if (!globalConfig || cliBackend) return
    if (providerId && modelId) return
    // Default pick from API providers only — do not wait on ACP discovery.
    const { apiModels, acpEndpoints } = buildGoalModelOptions(globalConfig, providers, [])
    const preferred = effectiveConfig
      ? { providerId: effectiveConfig.providerId, modelId: effectiveConfig.modelId }
      : null
    const picked = pickDefaultSelection(apiModels, acpEndpoints, preferred)
    if (picked) {
      setProviderId(picked.providerId)
      setModelId(picked.modelId)
    }
  }, [cliBackend, globalConfig, providers, effectiveConfig, providerId, modelId, setProviderId, setModelId])

  useEffect(() => {
    if (!sessionId) return
    void loadInputQueue(sessionId)
  }, [loadInputQueue, sessionId])

  const displayWikiAttachMode = isDraft
    ? wikiAttachMode
    : readSynaxWikiAttachMode(session?.sessionMetadata)
  const displayDocumentId = isDraft
    ? documentId
    : readSynaxDocumentId(session?.sessionMetadata)

  const handleSubmit = useCallback(async () => {
    const message = content.trim()
    if (!message || changingMode || incompatibleModel || (isGenerating && !queueWhileGenerating)) return
    setError(null)
    setContent('')
    setSubmitting(true)
    const model = backendId === 'native' ? formatTurnModel(providerId, modelId) : backendId.endsWith('-acp') ? `${backendId}/${providerId === backendId ? modelId ?? 'default' : 'default'}` : cliModel !== 'default' ? cliModel : undefined
    const effortPayload = reasoningEffort
    try {
      if (isDraft) {
        const { prompt, wikiContext } = await goalApi.buildSessionPrompt(projectId, {
          mode: 'session',
          content: message,
          wikiAttachMode,
          documentId: wikiAttachMode === 'manual' ? documentId : null,
          documentTitle: wikiAttachMode === 'manual' && documentId
            ? documents.find(d => d.id === documentId)?.title ?? null
            : null,
        })
        const created = await submitSessionDraft(projectId, {
          message,
          backendId,
          mode: acp ? 'chat' : draftMode,
          prompt,
          model,
          reasoningEffort: effortPayload,
          permissionTier: cliBackend ? undefined : permissionTier,
          skillIds,
          wikiAttachMode: wikiContext.mode,
          documentId: wikiContext.documentId,
        })
        navigate(sessionPath(projectId, created.id))
        setSkillIds([])
        await sendSessionMessage(created.id, {
          // Reference-enriched messages retain the app-authored marker; plain user messages stay visible.
          message: prompt,
          messageSource: prompt === message ? undefined : 'system_injection',
          model,
          reasoningEffort: effortPayload,
          permissionTier: cliBackend ? undefined : permissionTier,
        })
      } else {
        await submitOrEnqueueSessionInput(session.id, { message, model, reasoningEffort: effortPayload, permissionTier: cliBackend ? undefined : permissionTier })
      }
    } catch (error) {
      setContent(message)
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [
    backendId,
    cliModel,
    cliBackend,
    content,
    acp,
    draftMode,
    changingMode,
    incompatibleModel,
    documentId,
    documents,
    isDraft,
    isGenerating,
    modelId,
    mode,
    navigate,
    permissionTier,
    projectId,
    providerId,
    queueWhileGenerating,
    reasoningEffort,
    sendSessionMessage,
    session,
    skillIds,
    submitSessionDraft,
    submitOrEnqueueSessionInput,
    wikiAttachMode,
  ])

  const handleStop = useCallback(() => {
    if (session) void cancelSessionRun(session.id)
  }, [cancelSessionRun, session])

  const allowedReasoningEfforts: ReasoningEffort[] | undefined = cliBackend ? cliEfforts ?? (backendId === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max']) : providerId ? effectiveReasoningEfforts(globalConfig, providerId) : undefined
  const isCentered = layout === 'centered'
  const isFocusRail = layout === 'focusRail'
  const expandedShell = isCentered || content.includes('\n')

  const composer = (
    <GoalComposerPill
      modelControl={backendId === 'codex' || backendId === 'claude-code'
        ? <NativeBackendModelPicker key={backendId} backendId={backendId} model={cliModel} onChange={setCliModel} onEffortsChange={setCliEfforts} nativeMetadata={session?.sessionMetadata?.nativeBackend} disabled={submitting || isGenerating} /> : undefined}
      modeControl={<><SessionBackendPicker value={backendId} options={backendOptions} disabled={!isDraft || submitting}
        onChange={id => { setDraftBackendId(id); setError(null); if (id !== 'native') { setSkillIds([]); setProviderId(id); setModelId('default') } else { setProviderId(null); setModelId(null) } }} />
        <SessionModePicker mode={mode} disabled={!modeEnabled} onChange={next => void handleModeChange(next)}
        description={acp ? (zh ? '计划和目标模式仅适用于原生 Synax 引擎。' : 'Plan and goal require the native Synax engine.')
          : !modeEnabled ? (zh ? '会话空闲且无待处理请求时可切换模式。' : 'Switch when idle with no pending requests.')
            : (zh ? '模式不会改变工具权限。' : 'Mode does not change tool permissions.')} /></>}
      projectId={projectId}
      backendId={backendId}
      content={content}
      onContentChange={setContent}
      onSubmit={() => void handleSubmit()}
      onStop={handleStop}
      isGenerating={isGenerating}
      defaultExpanded={isCentered}
      providerId={providerId}
      modelId={modelId}
      onModelSelect={(selection) => {
        const selectedBackend = selection.kind === 'acp' ? selection.providerId : 'native'
        if (selectedBackend !== backendId) {
          setError(zh ? '请先选择对应的执行后端；已有会话需新建后切换。' : 'Choose the matching execution backend first; existing sessions keep their backend.')
          return
        }
        setProviderId(selection.providerId)
        setModelId(selection.modelId)
      }}
      providers={providers}
      globalConfig={globalConfig}
      documentId={displayDocumentId}
      onDocumentChange={isDraft ? setDocumentId : () => {}}
      wikiAttachMode={displayWikiAttachMode}
      onWikiAttachModeChange={isDraft ? setWikiAttachMode : () => {}}
      documents={documents}
      skillIds={skillIds}
      onSkillIdsChange={setSkillIds}
      reasoningEffort={reasoningEffort}
      onReasoningEffortChange={setReasoningEffort}
      allowedReasoningEfforts={allowedReasoningEfforts}
      permissionTier={permissionTier}
      onPermissionTierChange={handlePermissionTierChange}
      disabled={changingMode || (isGenerating && !queueWhileGenerating)}
      wikiAttachDisabled={!isDraft}
      queueWhileGenerating={queueWhileGenerating}
    />
  )

  const composerShell = (
    <div className="agent-session-controls w-full">
      {error && <p role="alert" className="mb-2 px-2 text-xs text-danger">{error}</p>}
      {incompatibleModel && <p role="alert" className="mb-2 px-2 text-xs text-danger">{zh ? '请选择当前后端的模型；切换执行后端需新建会话。' : 'Choose a model for this backend; start a new session to change backends.'}</p>}
      {session && <RuntimeRecoveryPanel key={`recovery-${session.id}`} session={session} />}
      {session && <AgentInteractionPanel key={session.id} session={session} />}
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
    </div>
  )

  return (
    <div
      className={
        isCentered
          ? 'goal-session-composer--centered flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10'
          : isFocusRail
            ? 'goal-session-composer goal-session-composer--focus-rail w-full shrink-0'
            : 'goal-session-composer goal-session-composer--footer shrink-0 px-4 pb-4 pt-2'
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
        <div className="mx-auto w-full min-w-0 max-w-3xl">
          {statusSlot}
          {composerShell}
        </div>
      )}
    </div>
  )
}
