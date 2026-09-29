import { Button } from "@/react/components/ui/Button";
import { Tooltip } from "@/react/components/ui/Tooltip";
import { WelcomeTypewriter } from "../WelcomeTypewriter";
import { useInputOptimization } from "./useInputOptimization";
import { useInputCapability } from "../../media/useInputCapability";
import {
  MediaAttachButton,
  MediaDraftPreview,
} from "../../media/MediaDraftControls";
import type { MediaDraft } from "../../media/useMediaDraft";
import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
  type KeyboardEvent,
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
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onInput: (value: string, cursor: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
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
  const keyboardHintId = useId();
  const keyboardHints = [
    locale === "zh" ? "Shift+Enter 换行" : "Shift+Enter for a new line",
    commands ? (locale === "zh" ? "/ 打开命令" : "/ for commands") : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
  const localTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = commands?.inputRef ?? localTextareaRef;
  const isComposingRef = useRef(false);
  const composerScope = JSON.stringify([projectId, sessionId ?? null]);
  const compositionScopeRef = useRef<string | null>(null);
  const suppressEnterRef = useRef(false);
  const isMultiline = content.includes("\n");
  const isSessionComposer = Boolean(modeControl);
  const expandedLayout = isSessionComposer || defaultExpanded || isMultiline;

  const handleCompositionStart = useCallback(() => {
    compositionScopeRef.current = composerScope;
    isComposingRef.current = true;
  }, [composerScope]);

  useLayoutEffect(() => {
    if (
      compositionScopeRef.current &&
      compositionScopeRef.current !== composerScope
    ) {
      // Commit/cancel the old IME editor without writing its final input into
      // the newly selected draft. Non-composing session switches keep focus.
      textareaRef.current?.blur();
      isComposingRef.current = false;
    }
  }, [composerScope, textareaRef]);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    // IME commit Enter often fires keydown after compositionend (isComposing already false).
    suppressEnterRef.current = true;
    window.setTimeout(() => {
      suppressEnterRef.current = false;
      compositionScopeRef.current = null;
    }, 20);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        isComposingRef.current ||
        suppressEnterRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229
      )
        return;
      if (commands?.onKeyDown(e)) return;
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
      mediaMode === "chat" ? onSubmit() : void submitMedia();
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
      isGenerating,
      onSubmit,
      queueWhileGenerating,
    ],
  );

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Inline pill stays single-line; scrollHeight includes placeholder padding and breaks alignment.
    if (!expandedLayout) {
      el.style.height = "";
      return;
    }
    if (!isSessionComposer && defaultExpanded && !isMultiline) {
      el.style.height = "";
      return;
    }
    const maxHeight = isSessionComposer || defaultExpanded ? 192 : 128;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [
    content,
    defaultExpanded,
    expandedLayout,
    isMultiline,
    isSessionComposer,
  ]);

  useLayoutEffect(() => {
    if (!defaultExpanded) return;
    textareaRef.current?.focus();
  }, [defaultExpanded]);

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

  const compositionProps = {
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  };

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
      onClick={stopMode ? onStop : resumeMode ? onResume : mediaMode === "chat" ? onSubmit : () => { void submitMedia(); }}
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
            textareaRef.current?.focus();
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
        if (
          media &&
          e.clipboardData.files.length &&
          (!disabled || queueWhileGenerating)
        ) {
          media.add(Array.from(e.clipboardData.files));
          if (!e.clipboardData.getData("text/plain")) e.preventDefault();
        }
      }}
      data-session-controls={modeControl ? "true" : undefined}
      data-multiline={expandedLayout ? "true" : undefined}
      data-expanded={defaultExpanded ? "true" : undefined}
    >
      <span id={keyboardHintId} className="sr-only">
        {keyboardHints}
      </span>
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
            <Tooltip
              content={keyboardHints}
              openOnFocus={false}
              placement="top-start"
            >
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                  if (
                    compositionScopeRef.current &&
                    compositionScopeRef.current !== composerScope
                  ) {
                    e.target.value = content;
                    return;
                  }
                  onContentChange(e.target.value);
                  commands?.onInput(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) =>
                  commands?.onInput(
                    e.currentTarget.value,
                    e.currentTarget.selectionStart,
                  )
                }
                aria-autocomplete={commands ? "list" : undefined}
                aria-controls={commands?.open ? commands.listId : undefined}
                aria-activedescendant={
                  commands?.open ? commands.activeId : undefined
                }
                onKeyDown={handleKeyDown}
                {...compositionProps}
                placeholder={
                  welcomePlaceholderDelay !== undefined
                    ? undefined
                    : inputPlaceholder
                }
                aria-label={t("agentPlaceholder")}
                aria-describedby={keyboardHintId}
                disabled={disabled && !queueWhileGenerating}
                rows={
                  isSessionComposer
                    ? 2
                    : defaultExpanded && !isMultiline
                      ? 4
                      : 1
                }
                className={`agent-dock-composer-input w-full resize-none border-0 bg-transparent px-0.5 py-0 text-[14px] font-normal leading-relaxed text-foreground/85 outline-none placeholder:text-muted-foreground/45 ${
                  isSessionComposer
                    ? "min-h-12 max-h-48"
                    : defaultExpanded && !isMultiline
                      ? "min-h-[5.5rem] max-h-48"
                      : "min-h-[1.5rem] max-h-32"
                }`}
              />
            </Tooltip>
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
            <Tooltip
              content={keyboardHints}
              openOnFocus={false}
              placement="top-start"
            >
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                  if (
                    compositionScopeRef.current &&
                    compositionScopeRef.current !== composerScope
                  ) {
                    e.target.value = content;
                    return;
                  }
                  onContentChange(e.target.value);
                  commands?.onInput(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) =>
                  commands?.onInput(
                    e.currentTarget.value,
                    e.currentTarget.selectionStart,
                  )
                }
                aria-autocomplete={commands ? "list" : undefined}
                aria-controls={commands?.open ? commands.listId : undefined}
                aria-activedescendant={
                  commands?.open ? commands.activeId : undefined
                }
                onKeyDown={handleKeyDown}
                {...compositionProps}
                placeholder={inputPlaceholder}
                aria-label={t("agentPlaceholder")}
                aria-describedby={keyboardHintId}
                disabled={disabled && !queueWhileGenerating}
                rows={1}
                className="agent-dock-composer-input min-h-[1.25rem] max-h-[1.25rem] min-w-0 flex-1 self-center resize-none border-0 bg-transparent px-0 py-0 text-[14px] font-normal leading-[1.25rem] text-foreground/85 outline-none placeholder:text-muted-foreground/45"
              />
            </Tooltip>
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
