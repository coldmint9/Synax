import "./composerModes.css";
import { Target } from "lucide-react";
import { NewSessionScene } from "./NewSessionScene";
import { welcomePlaceholderDelay } from "./welcomeTyping";
import { NewSessionWelcome } from "./NewSessionWelcome";
import {
  composerDraftScope,
  sessionComposerText,
  sessionComposerReferences,
  sessionComposerSkills,
  sessionComposerSubmitting,
  sessionComposerEditing,
  sessionComposerChangingMode,
  sessionComposerError,
  sessionComposerMode,
  sessionComposerPermissionTier,
} from "./state/sessionComposerDraftStore";
import { useSessionComposerSelection } from "./useSessionComposerSelection";
import {
  prepareQueuedMedia,
  restoreDraftMedia,
  useMediaDraft,
} from "../media/useMediaDraft";
import { useQueuedInputDraftStore } from "./state/queuedInputDraftStore";
import {
  clearDraftComposer,
  loadDraftComposer,
  loadDraftComposerContext,
  saveDraftComposer,
  saveDraftComposerContext,
} from "./state/draftComposerStore";
import { useComposerCommands } from "./useComposerCommands";
import type {
  GitWorkspaceSelection,
  TurnReference,
} from "../../adapters/transport/agentRuntime";
import { NativeBackendModelPicker } from "./NativeBackendModelPicker";
import { RuntimeRecoveryPanel } from "./RuntimeRecoveryPanel";
import { GitWorkspacePicker } from "./GitWorkspacePicker";
import { readSessionBackendId } from "./synaxSessionTypes";
import {
  readLastPermissionTier,
  rememberPermissionTier,
} from "./state/permissionTierPreference";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  EMPTY_INPUT_QUEUE,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import { useConfig } from "../settings/useConfig";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { useAgentDockStore } from "./state/agentDockStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { AgentComposer } from "./composer/AgentComposer";
import { formatModelReference } from "./composer/modelSelection";
import { sessionPath } from "./sessionRoutes";
import {
  isSessionComposerLocked,
  sessionHasPendingPermissions,
  canEnqueueSessionInput,
  canSwitchSessionMode,
  isSessionResumable,
} from "./sessionComposerState";
import { InputQueueStrip } from "./InputQueueStrip";
import { reducedMotion } from "../../shared/design/motion";
import type { RuntimeContentPart } from "../../adapters/transport/runtimeMedia";
import type {
  AgentSession,
  AgentSessionMode,
  ReasoningEffort,
  QueuedInput,
} from "../../adapters/transport/agentRuntime";
import { AgentInteractionPanel } from "./AgentInteractionPanel";
import { SessionModePicker } from "./SessionModePicker";
import { effectiveReasoningEfforts } from "../settings/lib/providerPresets";
import {
  readSynaxPermissionTier,
  readSynaxSessionMode,
  isUnsupportedSessionBackend,
  type SynaxPermissionTier,
} from "./synaxSessionTypes";

interface Props {
  projectId: string;
  session?: AgentSession;
  layout?: "footer" | "centered" | "focusRail";
  /** Rendered directly above the input pill (e.g. the file-change island). */
  statusSlot?: React.ReactNode;
  readingHistory?: boolean;
}

export function SessionComposer({
  session,
  projectId,
  layout = "footer",
  statusSlot,
  readingHistory = false,
}: Props) {
  const { t, locale } = useLocale();
  const zh = locale === "zh";
  const navigate = useNavigate();
  const sessionId = session?.id;
  const viewKey = composerDraftScope(
    projectId,
    sessionId ?? `draft:${projectId}`,
  );
  const [content, setContent] = sessionComposerText.useDraft(viewKey, () =>
    session ? "" : loadDraftComposer(projectId),
  );
  const [gitWorkspace, setGitWorkspace] = useState<GitWorkspaceSelection>();
  const location = useLocation();
  const [workspaceParams] = useSearchParams();
  const preselectedWorktree = location.pathname.endsWith("/sessions/new") ? workspaceParams.get("worktree") : null;
  const preselectedRootId = location.pathname.endsWith("/sessions/new") ? workspaceParams.get("rootId") ?? undefined : undefined;
  const [skillIds, setSkillIds] = sessionComposerSkills.useDraft(
    viewKey,
    () => [],
  );
  const [submitting, setSubmitting, readSubmitting] =
    sessionComposerSubmitting.useDraft(viewKey, () => false);
  const submitLock = useRef<object | null>(null);
  const composerRoot = useRef<HTMLDivElement>(null);
  const [changingMode, setChangingMode] = sessionComposerChangingMode.useDraft(
    viewKey,
    () => false,
  );
  const [editingQueue, setEditingQueue] = sessionComposerEditing.useDraft(
    viewKey,
    () => false,
  );
  const editLock = useRef<object | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [error, setError] = sessionComposerError.useDraft(viewKey, () => null);
  const [draftMode, setDraftMode] = sessionComposerMode.useDraft(
    viewKey,
    () => "chat",
  );
  const updateSessionMode = useAgentSessionStore((s) => s.updateSessionMode);
  const interactionState = useAgentSessionStore((s) => s.interactionState);
  const sendSessionMessage = useAgentSessionStore((s) => s.sendSessionMessage);
  const submitOrEnqueueSessionInput = useAgentSessionStore(
    (s) => s.submitOrEnqueueSessionInput,
  );
  const loadInputQueue = useAgentSessionStore((s) => s.loadInputQueue);
  const removeQueuedInput = useAgentSessionStore((s) => s.removeQueuedInput);
  const forceQueuedInput = useAgentSessionStore((s) => s.forceQueuedInput);
  const moveQueuedInput = useAgentSessionStore((s) => s.moveQueuedInput);
  const viewScope = useRef({ key: viewKey });
  if (viewScope.current.key !== viewKey) viewScope.current = { key: viewKey };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const queuedInputs = useAgentSessionStore((s) =>
    sessionId
      ? (s.inputQueues[sessionId] ?? EMPTY_INPUT_QUEUE)
      : EMPTY_INPUT_QUEUE,
  );
  const submitSessionDraft = useAgentSessionStore((s) => s.submitSessionDraft);
  const cancelSessionRun = useAgentSessionStore((s) => s.cancelSessionRun);
  const resumeSession = useAgentSessionStore((s) => s.resumeSession);
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const hasPendingPermissions = useAgentSessionStore((s) =>
    sessionHasPendingPermissions(sessionId, s.selectedSessionId, s.permissions),
  );
  const media = useMediaDraft(
    projectId,
    undefined,
    sessionId ? viewKey : undefined,
  );
  const hasMediaInput = media.parts.length > 0;
  const isDraft = !session;
  // New-session drafts start with the cached context references.
  const [references, setReferences] = sessionComposerReferences.useDraft(
    viewKey,
    () => (isDraft ? loadDraftComposerContext(projectId).references : []),
  );
  const createdDraftRef = useRef<AgentSession | null>(null);
  useLayoutEffect(() => {
    setGitWorkspace(preselectedWorktree && !session ? { kind: "worktree", path: preselectedWorktree, rootId: preselectedRootId } : undefined);
    setOverlayOpen(false);
    createdDraftRef.current = null;
  }, [viewKey, preselectedWorktree, preselectedRootId]);
  // Keep the new-session draft cached per project while typing; an empty
  // composer (sent or cleared) drops the cached entry.
  useEffect(() => {
    if (!isDraft || submitting) return;
    saveDraftComposer(projectId, content);
  }, [isDraft, projectId, content, submitting]);
  // Cached attachments reattach asynchronously; hold off overwriting the
  // context cache until that resolves (or nothing needed restoring).
  const [draftMediaHydrated, setDraftMediaHydrated] = useState(!isDraft);
  // Cache draft context (attachment parts + references) alongside the text.
  // Declared before hydration so a removal rewrites the cache first and the
  // hydration pass never resurrects a just-removed attachment.
  const contextPartsKey = JSON.stringify(media.parts);
  useEffect(() => {
    // Hold the snapshot while uploads run so the cache never records a
    // half-attached draft.
    if (!isDraft || submitting || !draftMediaHydrated || media.uploading)
      return;
    saveDraftComposerContext(projectId, {
      parts: JSON.parse(contextPartsKey) as RuntimeContentPart[],
      references,
    });
  }, [
    isDraft,
    projectId,
    submitting,
    draftMediaHydrated,
    media.uploading,
    contextPartsKey,
    references,
  ]);
  // Reattach cached attachments once their assets are confirmed. Only hydrate
  // an empty tray: items already in the composer are newer than the cache.
  useEffect(() => {
    if (!isDraft) return;
    if (media.items.length) {
      setDraftMediaHydrated(true);
      return;
    }
    const cached = loadDraftComposerContext(projectId).parts;
    if (!cached.length) {
      setDraftMediaHydrated(true);
      return;
    }
    let cancelled = false;
    setDraftMediaHydrated(false);
    restoreDraftMedia(cached)
      .then((items) => {
        if (!cancelled) media.restore(items);
      })
      .finally(() => {
        if (!cancelled) setDraftMediaHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDraft, projectId, media.items.length, media.restore]);
  const draftScopeRef = useRef({ isDraft, projectId });
  draftScopeRef.current = { isDraft, projectId };
  useEffect(
    () => () => {
      // An in-flight submit owns the text; leaving mid-send must not
      // resurrect it later as an unsent draft.
      if (draftScopeRef.current.isDraft && submitLock.current)
        clearDraftComposer(draftScopeRef.current.projectId);
    },
    [],
  );
  const currentInteractions =
    interactionState?.sessionId === sessionId ? interactionState : null;
  const pendingInteractions =
    currentInteractions?.items.filter((item) => item.status === "pending") ??
    [];
  const hasPendingInteractions = pendingInteractions.length > 0;
  const isGenerating = isSessionComposerLocked(session, {
    submitting,
    hasPendingPermissions,
    hasPendingInteractions,
  });
  const queueWhileGenerating =
    !hasPendingInteractions && canEnqueueSessionInput(session);
  const resyncedStaleWaitingRef = useRef(false);

  useEffect(() => {
    resyncedStaleWaitingRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (isDraft || !sessionId) return;
    if (session?.status !== "waiting_permission") return;
    if (hasPendingPermissions) return;
    if (resyncedStaleWaitingRef.current) return;
    resyncedStaleWaitingRef.current = true;
    void refreshSessions();
  }, [
    hasPendingPermissions,
    isDraft,
    refreshSessions,
    session?.status,
    sessionId,
  ]);

  const { providers, globalConfig, effectiveConfig } = useConfig(projectId);
  // New sessions always execute on the Synax-native runtime. Codex CLI sessions
  // stay reachable through subagent delegation only, so the composer exposes no
  // execution-backend selection at all.
  const backendId = session ? readSessionBackendId(session) : "native";
  const [cliEfforts, setCliEfforts] = useState<ReasoningEffort[] | undefined>();
  const cliBackend = backendId === "codex";
  useEffect(() => {
    setCliEfforts(undefined);
  }, [session?.id, backendId]);

  const {
    providerId,
    modelId,
    capability,
    cliModel,
    reasoningEffort,
    setSelection,
    markSubmitted,
  } = useSessionComposerSelection(
    projectId,
    session,
    backendId,
    globalConfig,
    providers,
    effectiveConfig,
  );
  const setCliModel = useCallback(
    (cliModel: string) => setSelection({ cliModel }),
    [setSelection],
  );
  const setReasoningEffort = useCallback(
    (reasoningEffort: ReasoningEffort) => setSelection({ reasoningEffort }),
    [setSelection],
  );
  const [draftPermissionTier, setDraftPermissionTier] =
    sessionComposerPermissionTier.useDraft(viewKey, readLastPermissionTier);
  const permissionTier = session
    ? readSynaxPermissionTier(session.sessionMetadata)
    : draftPermissionTier;
  const [draftSubagentsEnabled, setDraftSubagentsEnabled] = useState(() => {
    try {
      return localStorage.getItem("synax-subagents-enabled") !== "false";
    } catch {
      return true;
    }
  });
  const subagentsEnabled = session
    ? (session.sessionMetadata?.permissionOverrides as
        | { task?: "allow" | "ask" | "deny" }
        | undefined)?.task !== "deny"
    : draftSubagentsEnabled;
  const updateSessionPermissions = useAgentSessionStore(
    (s) => s.updateSessionPermissions,
  );
  const externalBackend = backendId !== "native";
  const unsupportedBackend = isUnsupportedSessionBackend(session);
  const mode = isDraft
    ? externalBackend
      ? "chat"
      : draftMode
    : readSynaxSessionMode(session.sessionMetadata);
  const modeEnabled =
    !submitting &&
    !editingQueue &&
    !changingMode &&
    canSwitchSessionMode(session, {
      externalBackend,
      hasPendingPermissions,
      hasPendingInteractions: Boolean(
        session &&
        (!currentInteractions ||
          currentInteractions.loading ||
          currentInteractions.error ||
          hasPendingInteractions),
      ),
    });
  const incompatibleModel = unsupportedBackend ||
    (backendId === "native" && Boolean(providerId?.endsWith("-acp")));

  const handleModeChange = async (next: AgentSessionMode) => {
    if (!modeEnabled)
      throw new Error(
        zh ? "当前无法切换模式" : "Mode cannot be switched right now",
      );
    setError(null);
    if (isDraft && !createdDraftRef.current) {
      setDraftMode(next);
      return;
    }
    setChangingMode(true);
    try {
      await updateSessionMode(session?.id ?? createdDraftRef.current!.id, next);
      if (isDraft) setDraftMode(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setChangingMode(false);
    }
  };

  const handlePermissionTierChange = useCallback(
    async (tier: SynaxPermissionTier) => {
      if (sessionId)
        await updateSessionPermissions(sessionId, { permissionTier: tier });
      if (!sessionId) setDraftPermissionTier(tier);
      // A new session inherits whatever the user picked last, here included.
      rememberPermissionTier(tier);
    },
    [sessionId, setDraftPermissionTier, updateSessionPermissions],
  );
  const handleSubagentsEnabledChange = useCallback(
    async (enabled: boolean) => {
      if (sessionId) {
        await updateSessionPermissions(sessionId, {
          permissionOverrides: { task: enabled ? "allow" : "deny" },
        });
      } else {
        setDraftSubagentsEnabled(enabled);
        try {
          localStorage.setItem("synax-subagents-enabled", String(enabled));
        } catch {
          // Storage is optional; the draft state still applies immediately.
        }
      }
    },
    [sessionId, updateSessionPermissions],
  );

  useEffect(() => {
    if (!sessionId) return;
    void loadInputQueue(sessionId);
  }, [loadInputQueue, sessionId]);

  const handleSubmit = useCallback(async () => {
    if (capability !== "chat") return;
    const message = content.trim();
    if (
      (!message && !media.items.length) ||
      media.blocked ||
      readSubmitting() ||
      editingQueue ||
      submitLock.current === viewScope.current ||
      changingMode ||
      incompatibleModel ||
      (isGenerating && !queueWhileGenerating)
    )
      return;
    const submittedScope = viewScope.current;
    if (submittedScope.key !== viewKey) return;
    const isCurrent = () =>
      mounted.current && viewScope.current === submittedScope;
    setError(null);
    setSubmitting(true);
    submitLock.current = submittedScope;
    if (!isDraft) setContent("");
    const model =
      backendId === "native"
        ? formatModelReference(providerId, modelId)
        : cliModel !== "default" ? cliModel : undefined;
    try {
      // Attachments upload in the background; the send waits for whichever
      // ones are still in flight instead of disabling the composer.
      const uploaded = media.hasPendingUploads()
        ? await media.waitForUploads()
        : {
            parts: media.parts,
            itemIds: media.items.map((item) => item.id),
          };
      const body = {
        message,
        contentParts: uploaded.parts.length
          ? [
              ...(message ? [{ type: "text" as const, text: message }] : []),
              ...uploaded.parts,
            ]
          : undefined,
        model,
        reasoningEffort,
        references,
      };
      if (isDraft) {
        const created =
          createdDraftRef.current ??
          (await submitSessionDraft(projectId, {
            ...body,
            backendId,
            permissionTier: cliBackend ? undefined : permissionTier,
            permissionOverrides: { task: subagentsEnabled ? "allow" : "deny" },
            mode: externalBackend ? "chat" : draftMode,
            prompt: message,
            gitWorkspace,
          }));
        if (isCurrent()) createdDraftRef.current = created;
        await sendSessionMessage(created.id, body);
        markSubmitted(created.id);
        if (isCurrent()) {
          const root = composerRoot.current;
          if (root?.animate && !reducedMotion()) {
            await root.animate(
              [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-6px)" }],
              { duration: 160, easing: "ease-in", fill: "forwards" },
            ).finished.catch(() => undefined);
          }
          if (isCurrent()) {
            createdDraftRef.current = null;
            navigate(sessionPath(projectId, created.id), {
              state: { fromNewSession: true },
            });
          }
        }
      } else {
        await submitOrEnqueueSessionInput(session.id, body);
        markSubmitted(session.id);
      }
      if (!isDraft || isCurrent()) {
        setContent("");
        // Attachments added while this send waited stay in the composer.
        media.clear(uploaded.itemIds);
        setReferences([]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isDraft || isCurrent()) {
        setError(message);
        setContent(content);
      }
      if (!isCurrent())
        useNotificationStore.getState().push({
          type: "error",
          message: `${zh ? "后台会话提交失败" : "Background session submission failed"}: ${message}`,
        });
    } finally {
      if (submitLock.current === submittedScope) submitLock.current = null;
      setSubmitting(false);
    }
  }, [
    capability,
    media,
    readSubmitting,
    setContent,
    setReferences,
    setSubmitting,
    setError,
    zh,
    viewKey,
    content,
    submitting,
    editingQueue,
    changingMode,
    incompatibleModel,
    isGenerating,
    queueWhileGenerating,
    backendId,
    providerId,
    modelId,
    cliModel,
    reasoningEffort,
    cliBackend,
    permissionTier,
    subagentsEnabled,
    references,
    isDraft,
    projectId,
    externalBackend,
    draftMode,
    gitWorkspace,
    submitSessionDraft,
    sendSessionMessage,
    markSubmitted,
    navigate,
    submitOrEnqueueSessionInput,
    session,
  ]);

  const commands = useComposerCommands({
    onAttachFiles: media.add,
    projectId,
    sessionId,
    backendId,
    content,
    setContent,
    references,
    setReferences,
    mode,
    modeEnabled,
    onModeChange: handleModeChange,
    compactDisabled:
      isGenerating ||
      submitting ||
      !session ||
      !["completed", "failed", "cancelled", "interrupted", "paused"].includes(
        session.status,
      ),
    disabled:
      submitting ||
      editingQueue ||
      changingMode ||
      (isGenerating && !queueWhileGenerating),
  });

  const recoveredQueueDraft = useQueuedInputDraftStore((state) =>
    sessionId ? state.drafts[sessionId] : undefined,
  );
  useEffect(() => {
    if (
      !sessionId ||
      !recoveredQueueDraft ||
      content.trim() ||
      media.items.length ||
      references.length ||
      submitting ||
      changingMode
    )
      return;
    const { item, attachments } = recoveredQueueDraft;
    setContent(item.message);
    media.restore(attachments);
    setReferences(item.references ?? []);
    if (item.reasoningEffort) setReasoningEffort(item.reasoningEffort);
    if (item.model) {
      if (backendId === "native") {
        const separator = item.model.indexOf("/");
        if (separator > 0)
          setSelection({
            providerId: item.model.slice(0, separator),
            modelId: item.model.slice(separator + 1),
          });
      } else setCliModel(item.model);
    }
    useQueuedInputDraftStore.getState().clear(sessionId, item.id);
    commands.inputRef.current?.focus();
  }, [
    sessionId,
    recoveredQueueDraft,
    content,
    media.items.length,
    media.restore,
    references.length,
    submitting,
    changingMode,
    backendId,
    setSelection,
    setReasoningEffort,
    setCliModel,
    commands.inputRef,
  ]);

  const editQueuedInput = async (item: QueuedInput) => {
    if (
      !sessionId ||
      submitting ||
      changingMode ||
      content.trim() ||
      media.items.length ||
      references.length ||
      recoveredQueueDraft ||
      editLock.current === viewScope.current
    )
      return;
    const scope = viewScope.current;
    editLock.current = scope;
    setEditingQueue(true);
    try {
      const attachments = await prepareQueuedMedia(item.contentParts);
      // A failed removal means the item may already be executing; never reinsert it as a draft.
      await removeQueuedInput(sessionId, item.id);
      useQueuedInputDraftStore
        .getState()
        .save(sessionId, { item, attachments });
    } catch (error) {
      void loadInputQueue(sessionId);
      throw error;
    } finally {
      if (editLock.current === scope) editLock.current = null;
      setEditingQueue(false);
    }
  };

  const handleStop = useCallback(() => {
    if (session) void cancelSessionRun(session.id);
  }, [cancelSessionRun, session]);

  const isResumable = isSessionResumable(session);
  const handleResume = useCallback(() => {
    if (!session) return;
    // Typed input rides along: sending a message to a resting session resumes it.
    if (content.trim() || media.parts.length) {
      void handleSubmit();
      return;
    }
    setError(null);
    void resumeSession(session.id);
  }, [session, content, media, handleSubmit, resumeSession]);

  const allowedReasoningEfforts: ReasoningEffort[] | undefined = cliBackend
    ? (cliEfforts ??
      (backendId === "codex"
        ? ["low", "medium", "high", "xhigh"]
        : ["low", "medium", "high", "xhigh", "max"]))
    : providerId
      ? effectiveReasoningEfforts(globalConfig, providerId)
      : undefined;
  const isCentered = layout === "centered";
  const isFocusRail = layout === "focusRail";

  const composer = (
    <AgentComposer
      optimizationScope={viewKey}
      media={media}
      sessionId={sessionId ?? undefined}
      inputModel={
        cliBackend ? (cliModel === "default" ? undefined : cliModel) : undefined
      }
      commands={commands}
      placeholder={
        mode === "goal"
          ? t("sessionGoalPlaceholder")
          : t("sessionComposePlaceholder")
      }
      welcomePlaceholderDelay={isCentered ? welcomePlaceholderDelay(t("sessionDraftTitle")) : undefined}
      onOverlayOpenChange={setOverlayOpen}
      modelControl={
        backendId === "codex" ? (
          <NativeBackendModelPicker
            key={backendId}
            backendId={backendId}
            model={cliModel}
            onChange={setCliModel}
            onEffortsChange={setCliEfforts}
            nativeMetadata={session?.sessionMetadata?.nativeBackend}
            onOpenChange={setOverlayOpen}
            disabled={submitting || isGenerating}
          />
        ) : undefined
      }
      modeControl={
        <div className="flex items-center gap-1">
          {backendId === "native" && mode === "goal" && (
            <span
              role="img"
              aria-label={zh ? "目标模式" : "Goal mode"}
              title={zh ? "目标模式" : "Goal mode"}
              className="inline-flex shrink-0 items-center text-[hsl(var(--electric-purple))]"
            >
              <Target size={14} aria-hidden="true" />
            </span>
          )}
          {!externalBackend && backendId !== "native" ? (
            <SessionModePicker
              mode={mode}
              disabled={!modeEnabled}
              description={
                zh
                  ? "模式与审批权限独立控制；运行中或有待处理请求时不可切换。"
                  : "Mode and approval are independent; switching is disabled while busy or pending."
              }
              onChange={handleModeChange}
            />
          ) : null}
        </div>
      }
      projectId={projectId}
      backendId={backendId}
      content={content}
      onContentChange={setContent}
      onSubmit={() => void handleSubmit()}
      onCreateMediaSession={async (prompt) => {
        if (backendId !== "native") throw new Error("媒体生成仅支持原生执行后端。");
        if (session) return session.id;
        if (createdDraftRef.current) return createdDraftRef.current.id;
        const created = await submitSessionDraft(projectId, {
          message: prompt,
          prompt,
          backendId,
          mode: "chat",
          mediaGeneration: providerId && modelId && capability !== "chat"
            ? { providerId, modelId, capability }
            : undefined,
          permissionTier,
          permissionOverrides: { task: subagentsEnabled ? "allow" : "deny" },
          gitWorkspace,
        });
        createdDraftRef.current = created;
        markSubmitted(created.id);
        return created.id;
      }}
      onMediaSubmitted={(id) => {
        if (isDraft) {
          createdDraftRef.current = null;
          clearDraftComposer(projectId);
          navigate(sessionPath(projectId, id));
        }
      }}
      onStop={handleStop}
      isGenerating={isGenerating}
      isResumable={isResumable}
      onResume={isResumable ? handleResume : undefined}
      defaultExpanded={isCentered}
      providerId={providerId}
      modelId={modelId}
      capability={capability}
      onModelSelect={(selection) => {
        if (backendId !== "native") {
          setError(
            zh
              ? "请先选择对应的执行后端；已有会话需新建后切换。"
              : "Choose the matching execution backend first; existing sessions keep their backend.",
          );
          return;
        }
        setSelection({
          providerId: selection.providerId,
          modelId: selection.modelId,
          capability: selection.capability,
        });
      }}
      providers={providers}
      globalConfig={globalConfig}
      skillIds={skillIds}
      onSkillIdsChange={setSkillIds}
      subagentsEnabled={subagentsEnabled}
      onSubagentsEnabledChange={(enabled) => void handleSubagentsEnabledChange(enabled)}
      reasoningEffort={reasoningEffort}
      onReasoningEffortChange={setReasoningEffort}
      allowedReasoningEfforts={allowedReasoningEfforts}
      permissionTier={permissionTier}
      onPermissionTierChange={handlePermissionTierChange}
      disabled={
        unsupportedBackend ||
        submitting ||
        editingQueue ||
        changingMode ||
        (isGenerating && !queueWhileGenerating)
      }
      submitting={submitting}
      queueWhileGenerating={
        queueWhileGenerating && !submitting && !editingQueue && !changingMode
      }
    />
  );

  const goalMode = backendId === "native" && mode === "goal";

  const composerShell = (
    <div
      className="agent-session-controls w-full"
      data-composer-mode={goalMode ? "goal" : "chat"}
    >
      {error && (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {error}
        </p>
      )}
      {incompatibleModel && (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {unsupportedBackend
            ? (zh ? "此会话使用的执行后端已移除。历史记录仍可查看，请新建 Synax 会话继续。" : "This session's execution backend has been removed. Its history remains available; start a new Synax session to continue.")
            : (zh ? "请选择当前后端的模型；切换执行后端需新建会话。" : "Choose a model for this backend; start a new session to change backends.")}
        </p>
      )}
      {session && (
        <RuntimeRecoveryPanel
          key={`recovery-${session.id}`}
          session={session}
        />
      )}
      {session && !hasPendingInteractions && (
        <AgentInteractionPanel
          key={`interactions-${session.id}`}
          session={session}
          compact
        />
      )}
      {commands.menu}
      {sessionId && (
        <InputQueueStrip
          key={`input-queue-${sessionId}`}
          items={queuedInputs}
          onEdit={editQueuedInput}
          editDisabledReason={
            submitting || editingQueue || changingMode
              ? zh
                ? "请稍候"
                : "Please wait"
              : content.trim() ||
                  media.items.length ||
                  references.length ||
                  recoveredQueueDraft
                ? zh
                  ? "请先发送或清空输入框"
                  : "Send or clear the current draft first"
                : undefined
          }
          onReorder={(itemId, toIndex) =>
            moveQueuedInput(sessionId, itemId, { toIndex })
          }
          onRemove={(itemId) => removeQueuedInput(sessionId, itemId)}
          onForce={(itemId) => forceQueuedInput(sessionId, itemId)}
        />
      )}
      <div className="relative w-full">
        {/* Keep the workspace trigger above the input's clipped content. */}
        <div className="agent-session-composer-rail">
          {isDraft && (
            <div className="workspace-hill-anchor">
              <GitWorkspacePicker
                variant="hill"
                projectId={projectId}
                value={gitWorkspace ?? { kind: "default" }}
                rootId={preselectedRootId}
                disabled={submitting || Boolean(createdDraftRef.current)}
                onChange={setGitWorkspace}
              />
            </div>
          )}
          <div
            className={`agent-session-composer-shell agent-dock-shell w-full flex flex-col items-center${isCentered ? " agent-session-composer-shell--draft" : ""}`}
            data-has-media={hasMediaInput ? "true" : "false"}
            data-multiline="true"
          >
            <div
              className="agent-dock-shell-content agent-composer-ask-switch"
              data-ask-active={
                hasPendingInteractions ? "true" : "false"
              }
            >
              <div
                className="agent-composer-input-slot"
                aria-hidden={hasPendingInteractions}
                inert={hasPendingInteractions ? true : undefined}
              >
                {composer}
              </div>
              {session && hasPendingInteractions && (
                <div className="agent-composer-ask-slot">
                  <AgentInteractionPanel session={session} dock />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={composerRoot}
      className={
        isCentered
          ? "agent-session-composer--centered flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10"
          : isFocusRail
            ? "agent-session-composer agent-session-composer--focus-rail w-full shrink-0"
            : "agent-session-composer agent-session-composer--footer shrink-0 px-4 pb-4 pt-2"
      }
    >
      {isCentered ? (
        <NewSessionScene key={viewKey}>
          <NewSessionWelcome finish={Boolean(content)} />
          <div className="w-full min-w-0">
            <div data-welcome-enter="">{composerShell}</div>
          </div>
        </NewSessionScene>
      ) : (
        <div className="relative mx-auto w-full min-w-0 max-w-3xl">
          {statusSlot}
          {composerShell}
        </div>
      )}
    </div>
  );
}
