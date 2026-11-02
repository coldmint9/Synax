import { SuperDagCard } from "./super-coding/SuperDagCard";
import "./composerModes.css";
import { composerErrorText } from "./composerErrorPresentation";
import ComposerGitActions from "./git-actions/ComposerGitActions";
import { AlertCircle, Goal, Zap } from "lucide-react";
import { NewSessionScene } from "./NewSessionScene";
import { welcomePlaceholderDelay } from "./welcomeTyping";
import { NewSessionWelcome } from "./NewSessionWelcome";
import { HomeFeaturePanel } from "../home/HomeFeaturePanel";
import { QuickActionAttachmentBar } from "../quick-actions/QuickActionAttachmentBar";
import {
  QUICK_ACTIONS,
  appendQuickActionContext,
  buildQuickActionLaunch,
  findQuickAction,
  quickActionAttachment,
  restrictQuickActionSkills,
  visibleQuickActions,
  type QuickAction,
  type QuickActionAttachment,
  type QuickActionLaunch,
} from "../quick-actions/quickActions";
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
  sessionComposerQuickAction,
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
import { GitWorkspacePicker } from "./GitWorkspacePicker";
import { readSessionBackendId } from "./synaxSessionTypes";
import { readSessionContextUsage } from "./contextUsage";
import {
  readLastPermissionTier,
  rememberPermissionTier,
} from "./state/permissionTierPreference";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  EMPTY_INPUT_QUEUE,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "./streamingLiveBlocks";
import { readReplyActivity } from "./state/sessionLifecycle";
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
import type { ConversationController } from "./state/conversationController";
import { useScopedConversationValue } from "./state/useConversationState";
import { conversationActions } from "./state/conversationActions";
import { AgentQuickApproval, listPendingPermissions } from "./dock/AgentQuickApproval";
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
  onOpenSideChat?: () => void;
  /** Rendered directly above the input pill (e.g. the file-change island). */
  statusSlot?: React.ReactNode;
  readingHistory?: boolean;
  scopedConversation?: ConversationController;
}

export function SessionComposer({
  session,
  projectId,
  layout = "footer",
  onOpenSideChat,
  statusSlot,
  readingHistory = false,
  scopedConversation,
}: Props) {
  const { t, locale } = useLocale();
  const zh = locale === "zh";
  const signedIn = false;
  const availableQuickActions = useMemo(
    () => visibleQuickActions(QUICK_ACTIONS, { signedIn }).filter((action) => action.kind === "launch"),
    [signedIn],
  );
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
  const [launchingActionId, setLaunchingActionId] = useState<string | null>(null);
  const [error, setError] = sessionComposerError.useDraft(viewKey, () => null);
  const [draftMode, setDraftMode] = sessionComposerMode.useDraft(
    viewKey,
    () => "chat",
  );
  const updateSessionMode = useAgentSessionStore((s) => s.updateSessionMode);
  const interactionState = useAgentSessionStore((s) => scopedConversation ? null : s.interactionState);
  const scopedActions = useMemo(() => scopedConversation ? conversationActions(scopedConversation) : null, [scopedConversation]);
  const scopedPermissions = useScopedConversationValue(scopedConversation, s => s.history.permissions);
  const scopedInteractions = useScopedConversationValue(scopedConversation, s => s.interactions);
  const scopedInteractionLoading = useScopedConversationValue(scopedConversation, s => s.interactionLoading);
  const scopedInteractionError = useScopedConversationValue(scopedConversation, s => s.interactionError);
  const sendSessionMessage = useAgentSessionStore((s) => s.sendSessionMessage);
  const defaultSubmitOrEnqueue = useAgentSessionStore(
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
  const defaultCancel = useAgentSessionStore((s) => s.cancelSessionRun);
  const defaultResume = useAgentSessionStore((s) => s.resumeSession);
  const submitOrEnqueueSessionInput = scopedActions?.submitOrEnqueueSessionInput ?? defaultSubmitOrEnqueue;
  const cancelSessionRun = scopedActions?.cancelSessionRun ?? defaultCancel;
  const resumeSession = scopedActions?.resumeSession ?? defaultResume;
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const globalPendingPermissions = useAgentSessionStore((s) =>
    !scopedConversation && sessionHasPendingPermissions(sessionId, s.selectedSessionId, s.permissions),
  );
  const hasPendingPermissions = scopedConversation
    ? listPendingPermissions(scopedPermissions ?? []).length > 0 : globalPendingPermissions;
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
  // A procedure that needs user context is attached to the composer, never
  // sent on click. Drafts restore it with the rest of the cached context.
  const [pendingQuickAction, setPendingQuickAction] = sessionComposerQuickAction.useDraft(
    viewKey,
    () => (isDraft ? loadDraftComposerContext(projectId).quickAction : null),
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
      quickAction: pendingQuickAction,
    });
  }, [
    isDraft,
    projectId,
    submitting,
    draftMediaHydrated,
    media.uploading,
    contextPartsKey,
    references,
    pendingQuickAction,
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
  const currentInteractions = scopedConversation ? {
    sessionId, items: scopedInteractions ?? [], loading: scopedInteractionLoading, error: scopedInteractionError,
  } : interactionState?.sessionId === sessionId ? interactionState : null;
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
  // The hint reads the streaming step, not the persisted transcript: the reply
  // phase only exists while a step is still being written. These fields already
  // belong to the open transcript, so the composer reads them directly instead
  // of gating on `selectedSessionId` — a missed selection write must never make
  // the phase permanently invisible.
  const streamedLive = useAgentSessionStore((s) => s.streamingLive);
  const streamedStepId = useAgentSessionStore((s) => s.streamingStepId);
  const scopedLive = useScopedConversationValue(
    scopedConversation,
    (s) => s.streamingLive,
  );
  const scopedStepId = useScopedConversationValue(
    scopedConversation,
    (s) => s.streamingStepId,
  );
  const streamedBuffers = scopedConversation
    ? (scopedLive ?? EMPTY_STREAMING_BUFFERS)
    : streamedLive;
  const streamedStep = scopedConversation
    ? (scopedStepId ?? null)
    : streamedStepId;
  const replyActivity = useMemo(
    () => ({
      snapshot: readReplyActivity(
        streamedBuffers,
        streamedStep,
        isGenerating,
      ),
      text: streamedBuffers.pendingText,
    }),
    [isGenerating, streamedBuffers, streamedStep],
  );
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
    if (scopedConversation) void scopedConversation.refresh();
    else void refreshSessions();
  }, [
    scopedConversation,
    hasPendingPermissions,
    isDraft,
    refreshSessions,
    session?.status,
    sessionId,
  ]);

  const { providers, globalConfig, effectiveConfig } = useConfig(projectId);
  // New sessions always execute on the Synax-native runtime.
  const backendId = session ? readSessionBackendId(session) : "native";

  const {
    providerId,
    modelId,
    capability,
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
  const unsupportedBackend = isUnsupportedSessionBackend(session);
  const mode = isDraft ? draftMode : readSynaxSessionMode(session.sessionMetadata);
  const modeEnabled =
    !submitting &&
    !editingQueue &&
    !changingMode &&
    canSwitchSessionMode(session, {
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

  const handleSubmit = useCallback(async (launch?: QuickActionLaunch) => {
    if (capability !== "chat") return;
    const typed = content.trim();
    const attachedLaunch: QuickActionLaunch | undefined = pendingQuickAction
      ? {
          actionId: pendingQuickAction.actionId,
          text: pendingQuickAction.text,
          skillIds: pendingQuickAction.skillIds,
          mode: pendingQuickAction.mode,
        }
      : undefined;
    const effectiveLaunch = launch ?? attachedLaunch;
    // A shortcut starts the session with its own brief; anything already typed
    // is preserved as additional context instead of being overwritten.
    const message = (effectiveLaunch
      ? appendQuickActionContext(effectiveLaunch.text, typed, locale)
      : typed).trim();
    // Compose actions carry a procedure but not the user's context. Text, media
    // or a file reference counts as the missing context; skill chips do not.
    const hasFileReference = references.some((reference) => reference.kind === "file");
    if (!launch && pendingQuickAction?.requiresInput && !typed && !media.items.length && !hasFileReference) {
      setError(zh
        ? `先补充：${pendingQuickAction.hint ?? "任务所需信息"}，再发送。`
        : `Add ${pendingQuickAction.hint ?? "the required details"} before sending.`);
      return;
    }
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
    const model = formatModelReference(providerId, modelId);
    try {
      // Attachments upload in the background; the send waits for whichever
      // ones are still in flight instead of disabling the composer.
      const uploaded = media.hasPendingUploads()
        ? await media.waitForUploads()
        : {
            parts: media.parts,
            itemIds: media.items.map((item) => item.id),
          };
      const attachedSkillIds = pendingQuickAction?.skillIds ?? [];
      const activeSkillIds = launch?.skillIds ?? [...new Set([...skillIds, ...attachedSkillIds])];
      // A reused draft already exists, so its skills cannot be mounted at
      // creation; send them as this turn's references instead.
      const mountSkillsPerTurn = (!isDraft || Boolean(createdDraftRef.current)) && activeSkillIds.length > 0;
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
        ...(mountSkillsPerTurn ? { skillIds: activeSkillIds } : {}),
      };
      if (isDraft) {
        const created =
          createdDraftRef.current ??
          (await submitSessionDraft(projectId, {
            ...body,
            backendId: "native",
            skillIds: activeSkillIds.length ? activeSkillIds : undefined,
            permissionTier,
            permissionOverrides: { task: subagentsEnabled ? "allow" : "deny" },
            mode: launch?.mode ?? draftMode,
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
        setPendingQuickAction(null);
        if (isDraft) setSkillIds([]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isDraft || isCurrent()) {
        setError(message);
        setContent(typed);
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
    setSkillIds,
    setPendingQuickAction,
    setSubmitting,
    setError,
    zh,
    locale,
    viewKey,
    content,
    submitting,
    pendingQuickAction,
    editingQueue,
    changingMode,
    incompatibleModel,
    isGenerating,
    queueWhileGenerating,
    backendId,
    providerId,
    modelId,
    reasoningEffort,
    skillIds,
    permissionTier,
    subagentsEnabled,
    references,
    isDraft,
    projectId,
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
    onOpenSideChat,
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
    allowSubagents: !session?.parentSessionId,
    compactDisabled:
      Boolean(scopedConversation) ||
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
      }
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
    if (session) void cancelSessionRun(session.id).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [cancelSessionRun, session, setError]);

  const isResumable = isSessionResumable(session);
  const handleResume = useCallback(() => {
    if (!session) return;
    // Typed input rides along: sending a message to a resting session resumes it.
    if (content.trim() || media.parts.length) {
      void handleSubmit();
      return;
    }
    setError(null);
    // A refused continuation must land in the composer: an unhandled rejection
    // would leave the play key looking dead.
    void resumeSession(session.id).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }, [session, content, media, handleSubmit, resumeSession, setError]);

  const allowedReasoningEfforts = providerId
    ? effectiveReasoningEfforts(globalConfig, providerId)
    : undefined;
  const isCentered = layout === "centered";
  const isFocusRail = layout === "focusRail";

  const focusComposerInput = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    const input = commands.inputRef.current;
    if (!input?.isConnected) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }));

  const attachQuickActionAttachment = (attachment: QuickActionAttachment) => {
    if (submitting || changingMode || editingQueue || capability !== "chat") return;
    setPendingQuickAction(attachment);
    setError(null);
    focusComposerInput();
  };

  // A shortcut is a complete procedure. Without an attachment it starts the
  // session immediately. Once something is attached, choosing another
  // procedure replaces the attachment instead of sending a mixed request.
  const stageOrSendQuickAction = (action: QuickAction, launch: QuickActionLaunch) => {
    if (submitting || changingMode || editingQueue || capability !== "chat") return;
    if (pendingQuickAction) {
      const attachment = quickActionAttachment(action, launch, locale);
      if (attachment) attachQuickActionAttachment(attachment);
      return;
    }
    setError(null);
    if (isDraft) {
      setSkillIds(launch.skillIds);
      setLaunchingActionId(launch.actionId);
    }
    void handleSubmit(launch).finally(() => {
      if (isDraft) setLaunchingActionId(null);
    });
  };

  const runQuickAction = (launch: QuickActionLaunch) => {
    if (!isDraft) return;
    const action = findQuickAction(launch.actionId);
    if (!action) return;
    stageOrSendQuickAction(action, launch);
  };

  // The plus menu follows the same policy as the home grid: procedures that
  // need user context attach; everything else runs immediately.
  const selectQuickAction = (action: QuickAction, availableSkillIds?: readonly string[]) => {
    if (submitting || changingMode || editingQueue || capability !== "chat") return;
    const launch = buildQuickActionLaunch(action, { locale, signedIn });
    if (!launch) return;
    const restricted = restrictQuickActionSkills(action, launch, locale, availableSkillIds);
    if (action.kind === "launch" && action.policy === "compose") {
      const attachment = quickActionAttachment(action, restricted, locale);
      if (attachment) attachQuickActionAttachment(attachment);
      return;
    }
    stageOrSendQuickAction(action, restricted);
  };

  const dismissQuickAction = () => {
    setPendingQuickAction(null);
    setError(null);
    focusComposerInput();
  };

  const composerPlaceholder = pendingQuickAction
    ? pendingQuickAction.requiresInput
      ? pendingQuickAction.placeholder ?? t("sessionComposePlaceholder")
      : zh ? "可直接发送，或补充上下文后发送…" : "Send now, or add context…"
    : mode === "goal"
      ? t("sessionGoalPlaceholder")
      : t("sessionComposePlaceholder");
  const attachedActionReady = pendingQuickAction
    ? !pendingQuickAction.requiresInput ||
      Boolean(content.trim()) ||
      media.items.length > 0 ||
      references.some((reference) => reference.kind === "file")
    : false;
  const quickActionBar = pendingQuickAction ? (
    <QuickActionAttachmentBar attachment={pendingQuickAction} locale={locale}
      ready={attachedActionReady} onDismiss={dismissQuickAction} />
  ) : null;

  const superOrchestration =
    backendId === "native" && mode === "super" && sessionId ? (
      <SuperDagCard sessionId={sessionId} />
    ) : null;

  // Only the native runtime has mode marks; plan and every other backend
  // read as chat.
  const composerMode: "chat" | "goal" | "super" =
    backendId === "native" && (mode === "goal" || mode === "super")
      ? mode
      : "chat";
  const composerModeMark =
    composerMode === "goal"
      ? {
          icon: <Goal size={14} aria-hidden="true" />,
          label: zh ? "目标模式" : "Goal mode",
        }
      : composerMode === "super"
        ? {
            icon: <Zap size={14} aria-hidden="true" />,
            label: zh ? "Super 编码" : "Super mode",
          }
        : null;

  const composer = (
    <AgentComposer
      optimizationScope={viewKey}
      media={media}
      sessionId={sessionId ?? undefined}
      commands={commands}
      placeholder={composerPlaceholder}
      welcomePlaceholderDelay={isCentered && !pendingQuickAction ? welcomePlaceholderDelay(t("sessionDraftTitle")) : undefined}
      quickActions={capability === "chat" && !scopedConversation ? availableQuickActions : undefined}
      onQuickActionSelect={selectQuickAction}
      attachedActionReady={attachedActionReady}
      onOverlayOpenChange={setOverlayOpen}
      modeControl={
        <div className="flex items-center gap-1">
          {composerModeMark && (
            <span
              role="img"
              aria-label={composerModeMark.label}
              title={composerModeMark.label}
              className="agent-composer-mode-mark"
              data-mode={composerMode}
            >
              {composerModeMark.icon}
            </span>
          )}
        </div>
      }
      projectId={projectId}
      backendId={backendId}
      content={content}
      onContentChange={setContent}
      onSubmit={() => void handleSubmit()}
      onCreateMediaSession={async (prompt) => {
        if (backendId !== "native") throw new Error("媒体生成仅支持原生执行后端。");
        if (scopedConversation) throw new Error(zh ? "侧边聊天使用对话模型" : "Choose a chat model for side chat");
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
      replyActivity={replyActivity}
      defaultExpanded={isCentered}
      providerId={providerId}
      modelId={modelId}
      contextUsage={readSessionContextUsage(session)}
      capability={capability}
      onModelSelect={(selection) => {
        if (scopedConversation && selection.capability !== "chat") {
          setError(zh ? "侧边聊天使用对话模型" : "Choose a chat model for side chat");
          return;
        }
        if (backendId !== "native") {
          setError(
            zh
              ? "此会话的执行引擎已移除，请新建 Synax 会话。"
              : "This execution engine has been removed. Start a new Synax session.",
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
      permissionControl={scopedConversation ? <span className="agent-dock-composer-chip text-xs" title={zh ? "与主会话相同的读写权限；需要审批的操作在这里确认" : "Same read/write permissions as the main session; approvals happen here"}>{zh ? "同主会话" : "Same as main"}</span> : undefined}
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

  // Git entries act on the repository, never on the transcript viewport:
  // scrolling back into history must not lock Commit, Push or MR.
  const gitActions = session && !scopedConversation ? <ComposerGitActions
    session={session}
    projectId={projectId}
    inline
    disabled={submitting || changingMode || editingQueue || Boolean(session?.activeRunId)}
    ensureSession={async () => session}
    onOpenConversation={(id) => {
      void refreshSessions();
      navigate(sessionPath(projectId, id));
    }}
  /> : null;

  // Repository actions and orchestration share the session action surface.
  // The expanded graph takes a full row without moving it into the input shell.
  const composerTopRow = gitActions || superOrchestration ? (
    <div className="agent-session-action-row flex min-w-0 flex-wrap items-center">
      {gitActions}
      {superOrchestration}
    </div>
  ) : null;

  const composerShell = (
    <div
      className="agent-session-controls w-full"
      data-composer-mode={composerMode}
      data-composer-submitting={submitting ? "true" : "false"}
    >
      {error && (
        <p data-error-toast="off" role="alert" className="agent-composer-notice">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{composerErrorText(error, locale)}</span>
        </p>
      )}
      {incompatibleModel && (
        <p data-error-toast="off" role="alert" className="agent-composer-notice">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{unsupportedBackend
            ? (zh ? "此会话使用的执行后端已移除。历史记录仍可查看，请新建 Synax 会话继续。" : "This session's execution backend has been removed. Its history remains available; start a new Synax session to continue.")
            : (zh ? "请选择当前后端的模型；切换执行后端需新建会话。" : "Choose a model for this backend; start a new session to change backends.")}</span>
        </p>
      )}
      {scopedConversation && scopedPermissions && <AgentQuickApproval
        permissions={scopedPermissions} onReply={scopedConversation.replyPermission} />}
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
          ? `agent-session-composer--centered ${isDraft ? "agent-session-composer--home" : ""} flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10`
          : isFocusRail
            ? "agent-session-composer agent-session-composer--focus-rail w-full shrink-0"
            : "agent-session-composer agent-session-composer--footer shrink-0 px-4 pb-4 pt-2"
      }
    >
      {isCentered ? (
        <NewSessionScene key={viewKey} home={isDraft}>
          {isDraft ? <HomeFeaturePanel locale={locale} onLaunch={runQuickAction}
            onAttach={attachQuickActionAttachment} launchingId={launchingActionId}
            launchDisabled={submitting || changingMode || editingQueue || capability !== "chat"} />
            : <NewSessionWelcome finish={Boolean(content)} />}
          <div className="session-welcome-composer w-full min-w-0">
            <div data-welcome-enter="">{composerTopRow}{quickActionBar}{composerShell}</div>
          </div>
        </NewSessionScene>
      ) : (
        <div className="relative mx-auto w-full min-w-0 max-w-3xl">
          {composerTopRow}
          {statusSlot}
          {quickActionBar}
          {composerShell}
        </div>
      )}
    </div>
  );
}
