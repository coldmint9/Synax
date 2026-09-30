import { Button } from "@/react/components/ui/Button";
import { WelcomeTypewriter } from "../WelcomeTypewriter";
import { useInputOptimization } from "./useInputOptimization";
import {
  ComposerMarkdownEditor,
  type ComposerEditorHandle,
} from "./ComposerMarkdownEditor";
import { useInputCapability } from "../../media/useInputCapability";
import {
  MediaAttachButton,
  MediaDraftPreview,
} from "../../media/MediaDraftControls";
import type { MediaDraft } from "../../media/useMediaDraft";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Square,
  ArrowUp,
  Play,
  Sparkles,
  LoaderCircle,
  Undo2,
} from "lucide-react";
import type { ProviderDef } from "../../../../lib/contracts/config";
import type { GlobalConfig } from "../../../../lib/contracts/config";
import type { ReasoningEffort } from "../../../../lib/contracts/config";
import type { WikiDocument } from "../../../../lib/contracts/wiki";
import { useLocale } from "../../../../hooks/useLocale";
import { ComposerAttachMenu } from "./ComposerAttachMenu";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  ComposerEffortPicker,
  type ComposerReasoningEffort,
} from "./ComposerEffortPicker";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import {
  formatModelReference,
  type AgentModelSelection,
} from "./modelSelection";
import type { SynaxPermissionTier, SynaxWikiAttachMode } from "./composerTypes";
import { useMediaGenerationModels } from "../../media/MediaGenerationControls";
import { ImageGenerationInput } from "../../media/ImageGenerationInput";
import { VideoGenerationInput } from "../../media/VideoGenerationInput";
import { mediaJobInput, mediaOperationFor } from "../../media/mediaSubmission";
import { apiRequest } from "../../../../lib/api/origin";
import type { MediaJob, ModelCapability } from "../../../../lib/contracts/media-generation";

export interface ComposerCommands {
  inputRef: RefObject<ComposerEditorHandle | null>;
  onInput: (value: string, cursor: number) => void;
  onKeyDown: (event: globalThis.KeyboardEvent) => boolean;
  header: ReactNode;
  trigger: ReactNode;
  handlesAttachments?: boolean;
  open: boolean;
  listId: string;
  activeId?: string;
}

interface Props {
  optimizationScope?: string;
  media?: MediaDraft;
  sessionId?: string;
  inputModel?: string;
  commands?: ComposerCommands;
  /** Optional session-only control, beside the model picker in either layout. */
  backendId?: string;
  modelControl?: ReactNode;
  modeControl?: ReactNode;
  placeholder?: string;
  /** New-session-only visual hint; never changes the textarea value. */
  welcomePlaceholderDelay?: number;
  projectId: string;
  content: string;
  onContentChange: (value: string) => void;
  onSubmit: () => void;
  onCreateMediaSession?: (prompt: string) => Promise<string>;
  onMediaSubmitted?: (sessionId: string) => void;
  onStop?: () => void;
  isGenerating?: boolean;
  /** Resumable session: the action key becomes a play control that resumes. */
  isResumable?: boolean;
  onResume?: () => void;
  providerId: string | null;
  modelId: string | null;
  capability?: ModelCapability;
  onModelSelect: (selection: AgentModelSelection) => void;
  providers: ProviderDef[];
  globalConfig: GlobalConfig | null;
  documentId: string | null;
  onDocumentChange: (id: string | null) => void;
  wikiAttachMode: SynaxWikiAttachMode;
  onWikiAttachModeChange: (mode: SynaxWikiAttachMode) => void;
  documents: WikiDocument[];
  skillIds: string[];
  onSkillIdsChange: (ids: string[]) => void;
  reasoningEffort: ComposerReasoningEffort;
  onReasoningEffortChange: (effort: ComposerReasoningEffort) => void;
  /** Effort levels the currently selected provider allows. */
  allowedReasoningEfforts?: ReasoningEffort[];
  permissionTier: SynaxPermissionTier;
  onPermissionTierChange: (tier: SynaxPermissionTier) => void | Promise<void>;
  disabled?: boolean;
  wikiAttachDisabled?: boolean;
  onOverlayOpenChange?: (open: boolean) => void;
  /** Allow enqueue submit while the session is actively running. */
  queueWhileGenerating?: boolean;
  /** Start in expanded editor layout (textarea + toolbar) instead of compact inline pill. */
  defaultExpanded?: boolean;
}

export function AgentComposer({
  optimizationScope,
  commands,
  modelControl,
  backendId,
  modeControl,
  placeholder,
  welcomePlaceholderDelay,
  projectId,
  media,
  sessionId,
  inputModel,
  content,
  onContentChange,
  onSubmit,
  onCreateMediaSession,
  onMediaSubmitted,
  onStop,
  isGenerating = false,
  isResumable = false,
  onResume,
  providerId,
  modelId,
  capability = "chat",
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
  const { t, locale } = useLocale();
  const mediaMode = capability === "image_generation" ? "image" : capability === "video_generation" ? "video" : "chat";
  const mediaDraftKey = JSON.stringify([projectId, sessionId ?? 'draft', providerId, modelId, capability]);
  const readMediaParameters = useCallback((): Record<string, string | number | boolean> => {
    try {
      const saved = JSON.parse(localStorage.getItem(`synax-media-draft:${mediaDraftKey}`) ?? '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(saved).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean>;
    } catch { return {}; }
  }, [mediaDraftKey]);
  const [mediaDraft, setMediaDraft] = useState(() => ({ key: mediaDraftKey, values: readMediaParameters() }));
  const mediaParameters = mediaDraft.key === mediaDraftKey ? mediaDraft.values : readMediaParameters();
  const setMediaParameters = useCallback((values: Record<string, string | number | boolean>) => {
    setMediaDraft({ key: mediaDraftKey, values });
    try { localStorage.setItem(`synax-media-draft:${mediaDraftKey}`, JSON.stringify(values)); } catch { /* storage unavailable */ }
  }, [mediaDraftKey]);
  const [mediaJob, setMediaJob] = useState<MediaJob>();
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [submittingMedia, setSubmittingMedia] = useState(false);
  const mediaSubmitLock = useRef(false);
  const mediaKey = useRef<string | null>(null);
  const mediaSignature = useRef<string | null>(null);
  const mediaCatalog = useMediaGenerationModels(mediaMode);
  const selectedMediaModel = mediaCatalog.models.find((item) => item.providerId === providerId && item.modelId === modelId);
  const mediaOperation = mediaMode === "chat" ? undefined : mediaOperationFor(selectedMediaModel, mediaMode, Boolean(media?.parts.some((part) => part.type === 'image')));
  useEffect(() => {
    setMediaJob(undefined);
    setMediaError(null);
    mediaKey.current = null;
    mediaSignature.current = null;
    if (!sessionId || mediaMode === 'chat') return;
    let active = true;
    void apiRequest<{ jobs: MediaJob[] }>(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/media-jobs`, { silent: true })
      .then(({ jobs }) => {
        if (active) setMediaJob(jobs.find((job) => job.input.providerId === providerId && job.input.modelId === modelId));
      })
      .catch((error) => { if (active) setMediaError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [sessionId, providerId, modelId, mediaMode]);
  const submitMedia = useCallback(async () => {
    if (mediaSubmitLock.current || mediaMode === 'chat' || !media?.ready) return;
    mediaSubmitLock.current = true;
    setSubmittingMedia(true);
    setMediaError(null);
    try {
      const signature = JSON.stringify([providerId, modelId, mediaMode, content, media.parts, mediaParameters]);
      const key = mediaSignature.current === signature ? mediaKey.current : null;
      const input = mediaJobInput(selectedMediaModel, mediaMode, content, media.parts, mediaParameters, key ?? crypto.randomUUID());
      mediaKey.current = input.idempotencyKey;
      mediaSignature.current = signature;
      const targetSessionId = sessionId ?? await onCreateMediaSession?.(input.prompt);
      if (!targetSessionId) throw new Error('无法创建媒体会话。');
      const { job } = await apiRequest<{ job: MediaJob }>(`/api/agent-runtime/sessions/${encodeURIComponent(targetSessionId)}/media-jobs`, {
        method: 'POST', body: JSON.stringify(input),
      });
      mediaKey.current = null;
      mediaSignature.current = null;
      setMediaJob(job);
      if (targetSessionId !== sessionId) {
        try {
          const key = JSON.stringify([projectId, targetSessionId, providerId, modelId, capability]);
          localStorage.setItem(`synax-media-draft:${key}`, JSON.stringify(mediaParameters));
        } catch { /* storage unavailable */ }
      }
      onContentChange('');
      media.clear();
      onMediaSubmitted?.(targetSessionId);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : String(error));
    } finally {
      mediaSubmitLock.current = false;
      setSubmittingMedia(false);
    }
  }, [sessionId, projectId, providerId, modelId, capability, onCreateMediaSession, onMediaSubmitted, selectedMediaModel, mediaMode, media, content, mediaParameters, onContentChange]);
  const retryMedia = useCallback(async () => {
    if (!mediaJob || !sessionId || mediaSubmitLock.current || !['failed', 'cancelled', 'unknown'].includes(mediaJob.status)) return;
    mediaSubmitLock.current = true;
    setSubmittingMedia(true);
    setMediaError(null);
    try {
      const { projectId: _projectId, ...originalInput } = mediaJob.input;
      const { job } = await apiRequest<{ job: MediaJob }>(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/media-jobs`, {
        method: 'POST', body: JSON.stringify({ ...originalInput, idempotencyKey: crypto.randomUUID() }),
      });
      setMediaJob(job);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : String(error));
    } finally {
      mediaSubmitLock.current = false;
      setSubmittingMedia(false);
    }
  }, [mediaJob, sessionId]);
  useEffect(() => {
    if (!mediaJob || !sessionId || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(mediaJob.status)) return;
    const timer = window.setInterval(() => {
      void apiRequest<{ job: MediaJob }>(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/media-jobs/${mediaJob.id}`, { silent: true })
        .then(({ job }) => setMediaJob(job))
        .catch((error) => setMediaError(error instanceof Error ? error.message : String(error)));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [mediaJob, sessionId]);
  const cancelMedia = useCallback(() => {
    if (!mediaJob || !sessionId) return;
    void apiRequest<{ job: MediaJob }>(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/media-jobs/${mediaJob.id}/cancel`, { method: 'POST' })
      .then(({ job }) => setMediaJob(job))
      .catch((error) => setMediaError(error instanceof Error ? error.message : String(error)));
  }, [mediaJob, sessionId]);
  const inputPlaceholder = placeholder ?? t("agentPlaceholder");

  const inputCapability = useInputCapability(
    projectId,
    sessionId,
    backendId ?? "native",
    inputModel ??
      (providerId && modelId ? `${providerId}/${modelId}` : undefined),
    media,
    globalConfig?.updatedAt,
  );
  const optimization = useInputOptimization({
    scope: optimizationScope ?? JSON.stringify([projectId, sessionId ?? null]),
    projectId,
    content,
    model: formatModelReference(providerId, modelId),
    backendId: backendId ?? "native",
    onContentChange,
  });
  const localEditorRef = useRef<ComposerEditorHandle>(null);
  const editorRef = commands?.inputRef ?? localEditorRef;
  const suppressEnterRef = useRef(false);
  const historyCursorRef = useRef<ComposerHistoryCursor>(EMPTY_HISTORY_CURSOR);
  const historyCaretRef = useRef<number | null>(null);

  /** Any real edit ends history browsing; the next ArrowUp starts from newest. */
  const resetHistoryBrowsing = useCallback(() => {
    historyCursorRef.current = EMPTY_HISTORY_CURSOR;
  }, []);

  useEffect(() => {
    resetHistoryBrowsing();
  }, [composerScope, resetHistoryBrowsing]);

  // A recalled entry lands with the caret at its end, like a terminal does.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const caret = historyCaretRef.current;
    if (!el || caret === null) return;
    historyCaretRef.current = null;
    const position = Math.min(caret, el.value.length);
    el.setSelectionRange(position, position);
  }, [content, textareaRef]);

  const submitFromComposer = useCallback(() => {
    recordComposerInput(
      composerHistoryScope(projectId, sessionId ?? null),
      content,
    );
    resetHistoryBrowsing();
    onSubmit();
  }, [content, onSubmit, projectId, resetHistoryBrowsing, sessionId]);

  const recallComposerHistory = useCallback(
    (direction: -1 | 1, current: string): string | null => {
      const recalled = recallComposerInput(
        readComposerHistory(composerHistoryScope(projectId, sessionId ?? null)),
        historyCursorRef.current,
        direction,
        current,
      );
      if (!recalled) return null;
      historyCursorRef.current = recalled.cursor;
      return recalled.content;
    },
    [projectId, sessionId],
  );

  const handleHistoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return false;
      const el = event.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return false;
      const caret = el.selectionStart;
      // Only the first line recalls with ArrowUp and the last line with
      // ArrowDown; anywhere else the caret keeps moving inside the draft.
      if (event.key === "ArrowUp") {
        if (el.value.slice(0, caret).includes("\n")) return false;
      } else if (el.value.slice(caret).includes("\n")) return false;
      const recalled = recallComposerHistory(
        event.key === "ArrowUp" ? -1 : 1,
        el.value,
      );
      if (recalled === null) return false;
      event.preventDefault();
      historyCaretRef.current = recalled.length;
      onContentChange(recalled);
      commands?.onInput(recalled, recalled.length);
      return true;
    },
    [commands, onContentChange, recallComposerHistory],
  );
  const isMultiline = content.includes("\n");
  const isSessionComposer = Boolean(modeControl);
  const expandedLayout = isSessionComposer || defaultExpanded || isMultiline;

  useLayoutEffect(() => {
    if (!defaultExpanded) return;
    editorRef.current?.focus();
  }, [defaultExpanded, editorRef]);

  const handleKeyDown = useCallback(
    (e: globalThis.KeyboardEvent) => {
      if (
        suppressEnterRef.current ||
        e.isComposing ||
        e.keyCode === 229
      )
        return;
      if (commands?.onKeyDown(e)) return;
      if (handleHistoryKeyDown(e)) return;
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      if (disabled && !queueWhileGenerating) return;
      if (
        (!content.trim() && !media?.parts.length) ||
        (media && !media.ready) ||
        (mediaMode === "chat" && inputCapability.blocked) ||
        (mediaMode !== "chat" && (!selectedMediaModel || submittingMedia || Boolean(mediaJob && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(mediaJob.status))))
      )
        return;
      if (mediaMode === "chat") submitFromComposer();
      else void submitMedia();
    },
    [
      inputCapability.blocked,
      selectedMediaModel,
      submittingMedia,
      mediaJob,
      mediaMode,
      submitMedia,
      media,
      content,
      commands,
      disabled,
      handleHistoryKeyDown,
      isGenerating,
      queueWhileGenerating,
      submitFromComposer,
    ],
  );

  useEffect(() => {
    const levels =
      allowedReasoningEfforts && allowedReasoningEfforts.length > 0
        ? allowedReasoningEfforts
        : ([
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ] as ReasoningEffort[]);
    if (levels.includes(reasoningEffort)) return;
    const fallback: ReasoningEffort = levels.includes("high")
      ? "high"
      : (levels[0] ?? "high");
    if (fallback !== reasoningEffort) onReasoningEffortChange(fallback);
  }, [allowedReasoningEfforts, onReasoningEffortChange, reasoningEffort]);

  const resumeMode = mediaMode === "chat" && !isGenerating && isResumable && Boolean(onResume);
  const hasInput = Boolean(content.trim() || media?.parts.length);
  const queueMode = mediaMode === "chat" && isGenerating && queueWhileGenerating && hasInput;
  const stopMode = mediaMode === "chat" && isGenerating && !queueMode;
  const sendDisabled =
    (disabled && !queueWhileGenerating) ||
    !hasInput ||
    Boolean(media && !media.ready) ||
    (mediaMode === "chat" ? inputCapability.blocked :
      (!selectedMediaModel || submittingMedia || Boolean(mediaJob && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(mediaJob.status))));
  const mediaInputProps = {
    selected: selectedMediaModel,
    parameters: mediaParameters,
    onParameters: setMediaParameters,
    job: mediaJob,
    error: mediaError,
    onCancel: () => { void cancelMedia(); },
    onRetry: () => { void (mediaJob ? retryMedia() : submitMedia()); },
    media,
  };
  const mediaInput = mediaMode === 'image'
    ? <ImageGenerationInput {...mediaInputProps} operation={mediaOperation as 'text-to-image' | 'image-to-image' | undefined} />
    : mediaMode === 'video'
      ? <VideoGenerationInput {...mediaInputProps} operation={mediaOperation as 'text-to-video' | 'image-to-video' | undefined} />
      : null;
  const actionButton = (
    <Button
      size="md"
      iconOnly
      variant="ghost"
      type="button"
      aria-label={t(
        stopMode
          ? "agentStop"
          : queueMode
            ? "inputQueueSend"
            : resumeMode
              ? "sessionResume"
              : "agentSend",
      )}
      title={queueMode ? t("inputQueueSend") : undefined}
      data-queue-ready={queueMode && !sendDisabled ? "true" : undefined}
      className={`agent-dock-composer-chip agent-dock-composer-action ${stopMode ? "agent-dock-composer-stop" : "agent-dock-composer-send"} ms-auto inline-flex size-8 shrink-0 items-center justify-center !rounded-full transition-colors disabled:cursor-not-allowed`}
      disabled={stopMode ? !onStop : resumeMode ? disabled : sendDisabled}
      onClick={stopMode ? onStop : resumeMode ? onResume : mediaMode === "chat" ? submitFromComposer : () => { void submitMedia(); }}
    >
      {stopMode ? (
        <Square size={12} fill="currentColor" />
      ) : resumeMode ? (
        <Play size={13} fill="currentColor" />
      ) : (
        <ArrowUp size={15} />
      )}
    </Button>
  );

  const optimizeLabel =
    locale === "zh" ? "澄清并优化输入" : "Clarify and optimize input";
  const undoLabel = locale === "zh" ? "撤销优化" : "Undo optimization";
  const optimizationButtons = (
    <>
      {optimization.canUndo && (
        <button
          type="button"
          aria-label={undoLabel}
          title={undoLabel}
          onClick={() => {
            optimization.undo();
            editorRef.current?.focus();
          }}
          disabled={disabled && !queueWhileGenerating}
          className="agent-dock-composer-chip inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Undo2 size={15} />
        </button>
      )}
      <button
        type="button"
        aria-label={optimizeLabel}
        title={
          optimization.pending
            ? locale === "zh"
              ? "正在优化…"
              : "Optimizing…"
            : optimizeLabel
        }
        aria-busy={optimization.pending}
        disabled={
          !content.trim() ||
          optimization.pending ||
          Boolean(disabled && !queueWhileGenerating)
        }
        onClick={() => void optimization.optimize()}
        className="agent-dock-composer-chip inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {optimization.pending ? (
          <LoaderCircle size={15} className="animate-spin" />
        ) : (
          <Sparkles size={15} />
        )}
      </button>
    </>
  );

  const toolbar = (
    <>
      <div className="agent-dock-composer-leading contents">
        {media && !commands?.handlesAttachments && (
          <MediaAttachButton
            media={media}
            disabled={disabled && !queueWhileGenerating}
          />
        )}
        {commands?.trigger ?? (
          <ComposerAttachMenu
            skillsDisabled={Boolean(backendId && backendId !== "native")}
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
          />
        )}

        <ComposerPermissionPicker
          sessionId={sessionId}
          backendId={backendId}
          value={permissionTier}
          onChange={onPermissionTierChange}
        />
        {mediaInput}
        {modeControl}
      </div>
      <div className="agent-dock-composer-settings contents">
        {modelControl ?? (
          <ComposerModelPicker
            backendId={backendId}
            globalConfig={globalConfig}
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            onSelect={onModelSelect}
            disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
            onOverlayOpenChange={onOverlayOpenChange}
          />
        )}

        <ComposerEffortPicker
          effort={reasoningEffort}
          allowed={allowedReasoningEfforts}
          modelLabel={modelId}
          onChange={onReasoningEffortChange}
          disabled={disabled && !(isSessionComposer && queueWhileGenerating)}
          onOverlayOpenChange={onOverlayOpenChange}
        />
      </div>
      <div className="agent-dock-composer-actions contents">
        {optimizationButtons}
        {actionButton}
      </div>
    </>
  );

  const markdownEditor = (
    <Tooltip
      content={keyboardHints}
      openOnFocus={false}
      placement="top-start"
    >
      <ComposerMarkdownEditor
        ref={editorRef}
        value={content}
        onChange={onContentChange}
        onInput={commands?.onInput}
        onKeyDown={handleKeyDown}
        placeholder={
          welcomePlaceholderDelay !== undefined
            ? undefined
            : inputPlaceholder
        }
        ariaLabel={t("agentPlaceholder")}
        ariaDescribedBy={keyboardHintId}
        ariaAutocomplete={commands ? "list" : undefined}
        ariaControls={commands?.open ? commands.listId : undefined}
        ariaActiveDescendant={
          commands?.open ? commands.activeId : undefined
        }
        disabled={disabled && !queueWhileGenerating}
        minHeight={
          expandedLayout
            ? isSessionComposer
              ? "3rem"
              : defaultExpanded && !isMultiline
                ? "5.5rem"
                : "1.5rem"
            : "1.25rem"
        }
        maxHeight={expandedLayout ? "12rem" : "1.25rem"}
        className={
          expandedLayout
            ? "agent-dock-composer-input w-full text-[14px] font-normal leading-relaxed text-foreground/85"
            : "agent-dock-composer-input min-w-0 flex-1 self-center text-[14px] font-normal leading-[1.25rem] text-foreground/85"
        }
      />
    </Tooltip>
  );

  return (
    <div
      className="agent-dock-composer w-full"
      onDragOver={(e) => {
        if (media && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (media && e.dataTransfer.files.length) {
          e.preventDefault();
          if (!disabled || queueWhileGenerating)
            media.add(Array.from(e.dataTransfer.files));
        }
      }}
      onPaste={(e) => {
        const pastedText = e.clipboardData.getData("text/plain");
        const hasFiles = e.clipboardData.files.length > 0;
        if (
          media &&
          pastedText.length > 4000 &&
          !hasFiles &&
          (!disabled || queueWhileGenerating)
        ) {
          e.preventDefault();
          media.addText(pastedText);
          return;
        }
        if (
          media &&
          hasFiles &&
          (!disabled || queueWhileGenerating)
        ) {
          media.add(Array.from(e.clipboardData.files));
          if (!pastedText) e.preventDefault();
        }
      }}
      data-session-controls={modeControl ? "true" : undefined}
      data-multiline={expandedLayout ? "true" : undefined}
      data-expanded={defaultExpanded ? "true" : undefined}
    >
      {media && <MediaDraftPreview media={media} />}
      {inputCapability.error && inputCapability.text && (
        <p
          role="alert"
          className="w-full break-words px-1 py-1 text-[10px] text-danger"
        >
          {inputCapability.text}
        </p>
      )}
      {expandedLayout ? (
        <div className="contents">
          {commands?.header}
          <div
            key="editor"
            className={
              welcomePlaceholderDelay !== undefined
                ? "welcome-editor"
                : "contents"
            }
          >
            {markdownEditor}
            {welcomePlaceholderDelay !== undefined && (
              <div
                className="welcome-editor-hint"
                aria-hidden="true"
                hidden={Boolean(content)}
              >
                <WelcomeTypewriter
                  text={inputPlaceholder}
                  delay={welcomePlaceholderDelay}
                  finish={Boolean(content)}
                  decorative
                />
              </div>
            )}
          </div>
          <div className="agent-dock-composer-toolbar flex items-center gap-1.5">
            {toolbar}
          </div>
        </div>
      ) : (
        <div className="agent-dock-composer-inline flex h-11 items-center gap-1.5 px-1.5 pl-2.5">
          <ComposerAttachMenu
            skillsDisabled={Boolean(backendId && backendId !== "native")}
            projectId={projectId}
            documentId={documentId}
            onDocumentChange={onDocumentChange}
            wikiAttachMode={wikiAttachMode}
            onWikiAttachModeChange={onWikiAttachModeChange}
            documents={documents}
            skillIds={skillIds}
            onSkillIdsChange={onSkillIdsChange}
            disabled={disabled && !queueWhileGenerating}
            wikiAttachDisabled={wikiAttachDisabled}
            onOverlayOpenChange={onOverlayOpenChange}
          />
          <ComposerPermissionPicker
            sessionId={sessionId}
            backendId={backendId}
            value={permissionTier}
            onChange={onPermissionTierChange}
          />
          {mediaInput}
        {modeControl}
          {/* The keyed editor keeps the same parent and DOM node in either layout. */}
          <div key="editor" className="contents">
            {markdownEditor}
          </div>
          {modelControl ?? (
            <ComposerModelPicker
              backendId={backendId}
              globalConfig={globalConfig}
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              capability={capability}
              onSelect={onModelSelect}
              disabled={disabled && !queueWhileGenerating}
              onOverlayOpenChange={onOverlayOpenChange}
            />
          )}
          <ComposerEffortPicker
            effort={reasoningEffort}
            allowed={allowedReasoningEfforts}
            modelLabel={modelId}
            onChange={onReasoningEffortChange}
            disabled={disabled && !queueWhileGenerating}
            onOverlayOpenChange={onOverlayOpenChange}
          />
          {optimizationButtons}
          {actionButton}
        </div>
      )}
      {optimization.error && (
        <p role="alert" className="px-3 py-1 text-xs text-danger">
          {optimization.error}
        </p>
      )}
      {optimization.notice && (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          {optimization.notice}
        </p>
      )}
      {optimization.pending && (
        <span role="status" className="sr-only">
          {locale === "zh" ? "正在优化输入…" : "Optimizing input…"}
        </span>
      )}
    </div>
  );
}
