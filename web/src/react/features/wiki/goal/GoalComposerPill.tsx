import { useEffect, useLayoutEffect, useRef, useCallback, type ReactNode, type RefObject, type KeyboardEvent } from 'react'
import { Square, ArrowUp } from 'lucide-react'
import type { ProviderDef } from '../../../../lib/contracts/config'
import type { GlobalConfig } from '../../../../lib/contracts/config'
import type { ReasoningEffort } from '../../../../lib/contracts/config'
import type { WikiDocument } from '../../../../lib/contracts/wiki'
import { useLocale } from '../../../../hooks/useLocale'
import { GoalAttachMenu } from './GoalAttachMenu'
import { GoalModelPicker } from './GoalModelPicker'
import { GoalEffortPicker, type GoalReasoningEffort } from './GoalEffortPicker'
import { GoalPermissionCycle } from './GoalPermissionCycle'
import type { GoalModelSelection } from './goalModelOptions'
import type { GoalPermissionTier, GoalWikiAttachMode } from './goalAttachTypes'

export interface ComposerCommands {
  inputRef: RefObject<HTMLTextAreaElement | null>
  onInput: (value: string, cursor: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  header: ReactNode
  trigger: ReactNode
  open: boolean
  listId: string
  activeId?: string
}

interface Props {
  commands?: ComposerCommands
  /** Optional session-only control, beside the model picker in either layout. */
  backendId?: string
  modelControl?: ReactNode
  modeControl?: ReactNode
  projectId: string
  content: string
  onContentChange: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  isGenerating?: boolean
  providerId: string | null
  modelId: string | null
  onModelSelect: (selection: GoalModelSelection) => void
  providers: ProviderDef[]
  globalConfig: GlobalConfig | null
  documentId: string | null
  onDocumentChange: (id: string | null) => void
  wikiAttachMode: GoalWikiAttachMode
  onWikiAttachModeChange: (mode: GoalWikiAttachMode) => void
  documents: WikiDocument[]
  skillIds: string[]
  onSkillIdsChange: (ids: string[]) => void
  reasoningEffort: GoalReasoningEffort
  onReasoningEffortChange: (effort: GoalReasoningEffort) => void
  /** Effort levels the currently selected provider allows. */
  allowedReasoningEfforts?: ReasoningEffort[]
  permissionTier: GoalPermissionTier
  onPermissionTierChange: (tier: GoalPermissionTier) => void
  disabled?: boolean
  wikiAttachDisabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
  /** Allow enqueue submit while the session is actively running. */
  queueWhileGenerating?: boolean
  /** Start in expanded editor layout (textarea + toolbar) instead of compact inline pill. */
  defaultExpanded?: boolean
}

export function GoalComposerPill({
  commands,
  modelControl,
  backendId,
  modeControl,
  projectId,
  content,
  onContentChange,
  onSubmit,
  onStop,
  isGenerating = false,
  providerId,
  modelId,
  onModelSelect,
  providers,
  globalConfig,
  documentId,
  onDocumentChange,
  wikiAttachMode,
  onWikiAttachModeChange,
  documents,
  skillIds,
  onSkillIdsChange,
  reasoningEffort,
  onReasoningEffortChange,
  allowedReasoningEfforts,
  permissionTier,
  onPermissionTierChange,
  disabled,
  wikiAttachDisabled,
  onOverlayOpenChange,
  queueWhileGenerating = false,
  defaultExpanded = false,
}: Props) {
  const { t } = useLocale()
  const localTextareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = commands?.inputRef ?? localTextareaRef
  const isComposingRef = useRef(false)
  const suppressEnterRef = useRef(false)
  const isMultiline = content.includes('\n')
  const isSessionComposer = Boolean(modeControl)
  const expandedLayout = isSessionComposer || defaultExpanded || isMultiline

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false
    // IME commit Enter often fires keydown after compositionend (isComposing already false).
    suppressEnterRef.current = true
    window.setTimeout(() => {
      suppressEnterRef.current = false
    }, 20)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      isComposingRef.current
      || suppressEnterRef.current
      || e.nativeEvent.isComposing
      || e.keyCode === 229
    ) return
    if (commands?.onKeyDown(e)) return
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (disabled && !queueWhileGenerating) return
    if (!content.trim()) return
    onSubmit()
  }, [content, commands, disabled, isGenerating, onSubmit, queueWhileGenerating])

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // Inline pill stays single-line; scrollHeight includes placeholder padding and breaks alignment.
    if (!expandedLayout) {
      el.style.height = ''
      return
    }
    if (!isSessionComposer && defaultExpanded && !isMultiline) {
      el.style.height = ''
      return
    }
    const maxHeight = isSessionComposer || defaultExpanded ? 192 : 128
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [content, defaultExpanded, expandedLayout, isMultiline, isSessionComposer])

  useLayoutEffect(() => {
    if (!defaultExpanded) return
    textareaRef.current?.focus()
  }, [defaultExpanded])

  useEffect(() => {
    const levels = allowedReasoningEfforts && allowedReasoningEfforts.length > 0
      ? allowedReasoningEfforts
      : ['low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[]
    if (levels.includes(reasoningEffort)) return
    const fallback: ReasoningEffort = levels.includes('high') ? 'high' : (levels[0] ?? 'high')
    if (fallback !== reasoningEffort) onReasoningEffortChange(fallback)
  }, [allowedReasoningEfforts, onReasoningEffortChange, reasoningEffort])

  const compositionProps = {
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  }

  const toolbar = (
    <>
      <div className="goal-dock-composer-leading contents">
        {commands?.trigger ?? <GoalAttachMenu
          skillsDisabled={Boolean(backendId && backendId !== 'native')}
          projectId={projectId}
          documentId={documentId}
          onDocumentChange={onDocumentChange}
          wikiAttachMode={wikiAttachMode}
          onWikiAttachModeChange={onWikiAttachModeChange}
          documents={documents}
          skillIds={skillIds}
          onSkillIdsChange={onSkillIdsChange}
          disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
          wikiAttachDisabled={wikiAttachDisabled}
          onOverlayOpenChange={onOverlayOpenChange}
        />}

        <GoalPermissionCycle
          backendId={backendId}
          value={permissionTier}
          onChange={onPermissionTierChange}
          disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
        />
      </div>
      <div className="goal-dock-composer-settings contents">
        {modeControl}
        {modelControl ?? (<GoalModelPicker
          backendId={backendId}
          globalConfig={globalConfig}
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          onSelect={onModelSelect}
          disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
          onOverlayOpenChange={onOverlayOpenChange}
        />)}

        <GoalEffortPicker
          effort={reasoningEffort}
          allowed={allowedReasoningEfforts}
          modelLabel={modelId}
          onChange={onReasoningEffortChange}
          disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
          onOverlayOpenChange={onOverlayOpenChange}
        />
      </div>
      <div className="goal-dock-composer-actions contents">
        {isGenerating ? (
          queueWhileGenerating ? (
            <>
              {onStop && (
                <button
                  type="button"
                  aria-label={t('goalStop')}
                  className="goal-dock-composer-chip goal-dock-composer-stop inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors"
                  onClick={onStop}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                type="button"
                aria-label={t('goalSend')}
                className="goal-dock-composer-chip goal-dock-composer-send ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
                disabled={(disabled && !queueWhileGenerating) || !content.trim()}
                onClick={onSubmit}
              >
                <ArrowUp size={15} />
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={t('goalStop')}
              className="goal-dock-composer-chip goal-dock-composer-stop ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors"
              onClick={onStop}
            >
              <Square size={12} fill="currentColor" />
            </button>
          )
        ) : (
          <button
            type="button"
            aria-label={t('goalSend')}
            className="goal-dock-composer-chip goal-dock-composer-send ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
            disabled={disabled || !content.trim()}
            onClick={onSubmit}
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </>
  )

  return (
    <div
      className="goal-dock-composer w-full"
      data-session-controls={modeControl ? 'true' : undefined}
      data-multiline={expandedLayout ? 'true' : undefined}
      data-expanded={defaultExpanded ? 'true' : undefined}
    >
      {expandedLayout ? (
        <>
          {commands?.header}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => { onContentChange(e.target.value); commands?.onInput(e.target.value, e.target.selectionStart) }}
            onSelect={(e) => commands?.onInput(e.currentTarget.value, e.currentTarget.selectionStart)}
            aria-autocomplete={commands ? "list" : undefined}
            aria-controls={commands?.open ? commands.listId : undefined}
            aria-activedescendant={commands?.open ? commands.activeId : undefined}
            onKeyDown={handleKeyDown}
            {...compositionProps}
            placeholder={t('goalPlaceholder')}
            aria-label={t('goalPlaceholder')}
            disabled={disabled && !queueWhileGenerating}
            rows={isSessionComposer ? 2 : defaultExpanded && !isMultiline ? 4 : 1}
            className={`goal-dock-composer-input w-full resize-none border-0 bg-transparent px-0.5 py-0 text-[13px] leading-relaxed text-foreground/85 outline-none placeholder:text-muted-foreground/45 ${
              isSessionComposer ? 'min-h-12 max-h-48' : defaultExpanded && !isMultiline ? 'min-h-[5.5rem] max-h-48' : 'min-h-[1.5rem] max-h-32'
            }`}
          />
          <div className="goal-dock-composer-toolbar flex items-center gap-1.5">
            {toolbar}
          </div>
        </>
      ) : (
        <div className="goal-dock-composer-inline flex h-11 items-center gap-1.5 px-1.5 pl-2.5">
          <GoalAttachMenu
        skillsDisabled={Boolean(backendId && backendId !== 'native')}
            projectId={projectId}
            documentId={documentId}
            onDocumentChange={onDocumentChange}
            wikiAttachMode={wikiAttachMode}
            onWikiAttachModeChange={onWikiAttachModeChange}
            documents={documents}
            skillIds={skillIds}
            onSkillIdsChange={onSkillIdsChange}
            disabled={disabled && !queueWhileGenerating}
            onOverlayOpenChange={onOverlayOpenChange}
          />
          <GoalPermissionCycle
        backendId={backendId}
            value={permissionTier}
            onChange={onPermissionTierChange}
            disabled={disabled && !queueWhileGenerating}
          />
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => { onContentChange(e.target.value); commands?.onInput(e.target.value, e.target.selectionStart) }}
            onSelect={(e) => commands?.onInput(e.currentTarget.value, e.currentTarget.selectionStart)}
            aria-autocomplete={commands ? "list" : undefined}
            aria-controls={commands?.open ? commands.listId : undefined}
            aria-activedescendant={commands?.open ? commands.activeId : undefined}
            onKeyDown={handleKeyDown}
            {...compositionProps}
            placeholder={t('goalPlaceholder')}
            aria-label={t('goalPlaceholder')}
            disabled={disabled && !queueWhileGenerating}
            rows={1}
            className="goal-dock-composer-input min-h-[1.25rem] max-h-[1.25rem] min-w-0 flex-1 self-center resize-none border-0 bg-transparent px-0 py-0 text-[13px] leading-[1.25rem] text-foreground/85 outline-none placeholder:text-muted-foreground/45"
          />
          {modeControl}
          {modelControl ?? (<GoalModelPicker
        backendId={backendId}
            globalConfig={globalConfig}
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            onSelect={onModelSelect}
            disabled={disabled && !queueWhileGenerating}
            onOverlayOpenChange={onOverlayOpenChange}
          />)}
          <GoalEffortPicker
            effort={reasoningEffort}
            allowed={allowedReasoningEfforts}
            modelLabel={modelId}
            onChange={onReasoningEffortChange}
            disabled={disabled && !queueWhileGenerating}
            onOverlayOpenChange={onOverlayOpenChange}
          />
          {isGenerating ? (
            queueWhileGenerating ? (
              <>
                {onStop && (
                  <button
                    type="button"
                    aria-label={t('goalStop')}
                    className="goal-dock-composer-chip goal-dock-composer-stop inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors"
                    onClick={onStop}
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('goalSend')}
                  className="goal-dock-composer-chip goal-dock-composer-send inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
                  disabled={(disabled && !queueWhileGenerating) || !content.trim()}
                  onClick={onSubmit}
                >
                  <ArrowUp size={15} />
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-label={t('goalStop')}
                className="goal-dock-composer-chip goal-dock-composer-stop inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors"
                onClick={onStop}
              >
                <Square size={12} fill="currentColor" />
              </button>
            )
          ) : (
            <button
              type="button"
              aria-label={t('goalSend')}
              className="goal-dock-composer-chip goal-dock-composer-send inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
              disabled={disabled || !content.trim()}
              onClick={onSubmit}
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
