import "./composerModes.css";
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
  sessionComposerWikiAttachMode,
  sessionComposerDocumentId,
} from "./state/sessionComposerDraftStore";
import { useWikiStore } from "../../state/wikiStore";
import {
  useSessionComposerSelection,
  useSessionComposerSelections,
} from "./useSessionComposerSelection";
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
import { ComposerIsland } from "./ComposerIsland";
import { useComposerCommands } from "./useComposerCommands";
import type {
  GitWorkspaceSelection,
  TurnReference,
} from "../../../lib/api/agentRuntime";
import { NativeBackendModelPicker } from "./NativeBackendModelPicker";
import { RuntimeRecoveryPanel } from "./RuntimeRecoveryPanel";
import { agentRuntimeApi, type BackendId } from "../../../lib/api/agentRuntime";
import { SessionBackendPicker } from "./SessionBackendPicker";
import { GitWorkspacePicker } from "./GitWorkspacePicker";
import { readSessionBackendId } from "./synaxSessionTypes";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  EMPTY_INPUT_QUEUE,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import { useConfig } from "../settings/useConfig";
import { useNotificationStore } from "../../state/notificationStore";
import { useShellStore } from "../../state/shellStore";
import { useAgentDockStore } from "./state/agentDockStore";
import { useLocale } from "../../../hooks/useLocale";
import { AgentComposer } from "./composer/AgentComposer";
import {
  discoveredAcpProviders,
  formatModelReference,
} from "./composer/modelSelection";
import { useAcpDiscovery } from "./composer/useAcpDiscovery";
import { sessionPath } from "./sessionRoutes";
import {
  isSessionComposerLocked,
  sessionHasPendingPermissions,
  canEnqueueSessionInput,
  canSwitchSessionMode,
  isSessionResumable,
} from "./sessionComposerState";
import { InputQueueStrip } from "./InputQueueStrip";
import { UserMessageBlock } from "./UserMessageBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";
import type { RuntimeContentPart } from "../../../lib/api/runtimeMedia";
import type {
  AgentSession,
  AgentSessionMode,
  ReasoningEffort,
  QueuedInput,
} from "../../../lib/api/agentRuntime";
import { AgentInteractionPanel } from "./AgentInteractionPanel";
import { SessionModePicker } from "./SessionModePicker";
import { effectiveReasoningEfforts } from "../settings/lib/providerPresets";
import {
  readSynaxDocumentId,
  readSynaxPermissionTier,
  readSynaxWikiAttachMode,
  readSynaxSessionMode,
  isAcpSession,
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
  const [skillIds, setSkillIds] = sessionComposerSkills.useDraft(
    viewKey,
    () => [],
  );
  const [submitting, setSubmitting, readSubmitting] =
    sessionComposerSubmitting.useDraft(viewKey, () => false);
  const submitLock = useRef<object | null>(null);
  const [draftPreview, setDraftPreview] = useState<{
    scope: string;
    message: string;
    contentParts?: RuntimeContentPart[];
  } | null>(null);
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
  const [draftMode, setDraftMode] = sessionComposerMode.useDraft(viewKey, () => "chat");
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
    setGitWorkspace(undefined);
    setOverlayOpen(false);
    createdDraftRef.current = null;
  }, [viewKey]);
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
    if (!isDraft || submitting || !draftMediaHydrated) return;
    saveDraftComposerContext(projectId, {
      parts: JSON.parse(contextPartsKey) as RuntimeContentPart[],
      references,
    });
  }, [
    isDraft,
    projectId,
    submitting,
    draftMediaHydrated,
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
  const pendingClarificationInteractions = pendingInteractions.filter(
    (item) => item.kind === "clarification",
  );
  const hasPendingClarificationInteractions =
    pendingClarificationInteractions.length > 0;
  const onlyPlanApprovalPending = Boolean(
    currentInteractions &&
    !currentInteractions.loading &&
    !currentInteractions.error &&
    pendingInteractions.length > 0 &&
    pendingInteractions.every((item) => item.kind === "plan_approval"),
  );
  const isGenerating = isSessionComposerLocked(session, {
    submitting,
    hasPendingPermissions,
    hasPendingInteractions: hasPendingInteractions && !onlyPlanApprovalPending,
    allowWaitingInputForPlanApproval: onlyPlanApprovalPending,
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
  const wslProject = useShellStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.source
        ?.kind === "wsl",
  );
  const acpDiscovery = useAcpDiscovery({ enabled: isDraft });
  const availableAcp = discoveredAcpProviders(providers, acpDiscovery);
  const [draftBackendId, setDraftBackendId] = useState<BackendId>(() => {
    const lastSubmitted =
      useSessionComposerSelections.getState().lastSubmittedByProject[projectId];
    if (lastSubmitted) return lastSubmitted.backendId;
    const previous = useAgentDockStore.getState().composerProviderId;
    return previous?.endsWith("-acp") ? (previous as BackendId) : "native";
  });
  const backendId = session ? readSessionBackendId(session) : draftBackendId;
  const unavailableDraftAcp =
    isDraft &&
    backendId.endsWith("-acp") &&
    !availableAcp.some((provider) => provider.id === backendId);
  const [backendCatalog, setBackendCatalog] = useState<
    Array<{
      id: BackendId;
      label: string;
      kind: string;
      experimental?: boolean;
    }>
  >([]);
  const [cliEfforts, setCliEfforts] = useState<ReasoningEffort[] | undefined>();
  const cliBackend = backendId === "codex" || backendId === "claude-code";
  const backendOptions = wslProject
    ? [
        {
          id: "native" as BackendId,
          label: "native · WSL2",
        },
      ]
    : [
        { id: "native" as BackendId, label: "native" },
        ...backendCatalog
          .filter((backend) => backend.kind === "cli")
          .map((backend) => ({
            id: backend.id,
            label: `${backend.label}${backend.experimental ? " · Preview" : ""}`,
          })),
        ...availableAcp.map((provider) => ({
          id: provider.id as BackendId,
          label: provider.label ?? provider.id,
        })),
      ];
  useEffect(() => {
    if (isDraft && wslProject && draftBackendId !== "native")
      setDraftBackendId("native");
  }, [isDraft, wslProject, draftBackendId]);
  useEffect(() => {
    let active = true;
    void agentRuntimeApi
      .listBackends()
      .then((result) => {
        if (active) setBackendCatalog(result.items);
      })
      .catch(() => {
        if (active)
          setError(
            zh
              ? "无法读取执行后端目录，请检查 Runtime 连接。"
              : "Cannot load backends. Check the Runtime connection.",
          );
      });
    return () => {
      active = false;
    };
  }, [zh, setError]);
  useEffect(() => {
    setCliEfforts(undefined);
  }, [session?.id, backendId]);

  const {
    providerId,
    modelId,
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
    sessionComposerPermissionTier.useDraft(viewKey, () => "boundary");
  const permissionTier = session
    ? readSynaxPermissionTier(session.sessionMetadata)
    : draftPermissionTier;
  const [wikiAttachMode, setWikiAttachMode] =
    sessionComposerWikiAttachMode.useDraft(viewKey, () => "auto");
  const [documentId, setDocumentId] = sessionComposerDocumentId.useDraft(
    viewKey,
    () => null,
  );
  const wikiEnabled = useShellStore((s) => s.preferences.wikiEnabled);
  const documents = useWikiStore((s) => s.documents);
  const loadProjectSnapshot = useWikiStore((s) => s.loadProjectSnapshot);
  const updateSessionPermissions = useAgentSessionStore(
    (s) => s.updateSessionPermissions,
  );
  const acp = backendId !== "native";
  const mode = isDraft
    ? acp
      ? "chat"
      : draftMode
    : readSynaxSessionMode(session.sessionMetadata);
  const modeEnabled =
    !submitting &&
    !editingQueue &&
    !changingMode &&
    canSwitchSessionMode(session, {
      acp,
      hasPendingPermissions,
      hasPendingInteractions: Boolean(
        session &&
        (!currentInteractions ||
          currentInteractions.loading ||
          currentInteractions.error ||
          hasPendingInteractions),
      ),
    });
  const incompatibleModel =
    backendId === "native" && Boolean(providerId?.endsWith("-acp"));

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

  useEffect(() => {
    if (!projectId) return;
    if (wikiEnabled) void loadProjectSnapshot(projectId);
  }, [loadProjectSnapshot, projectId, wikiEnabled]);

  const handlePermissionTierChange = useCallback(
    async (tier: SynaxPermissionTier) => {
      if (sessionId)
        await updateSessionPermissions(sessionId, { permissionTier: tier });
      if (!sessionId) setDraftPermissionTier(tier);
    },
    [sessionId, setDraftPermissionTier, updateSessionPermissions],
  );

  useEffect(() => {
    if (!sessionId) return;
    void loadInputQueue(sessionId);
  }, [loadInputQueue, sessionId]);

  const displayWikiAttachMode = isDraft
    ? wikiAttachMode
    : readSynaxWikiAttachMode(session?.sessionMetadata);
  const displayDocumentId = isDraft
    ? documentId
    : readSynaxDocumentId(session?.sessionMetadata);

  const handleSubmit = useCallback(async () => {
    const message = content.trim();
    if (
      (!message && !media.parts.length) ||
      !media.ready ||
      readSubmitting() ||
      editingQueue ||
      submitLock.current === viewScope.current ||
      changingMode ||
      incompatibleModel ||
      unavailableDraftAcp ||
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
    setContent("");
    const model =
      backendId === "native"
        ? formatModelReference(providerId, modelId)
        : backendId.endsWith("-acp")
          ? `${backendId}/${providerId === backendId ? (modelId ?? "default") : "default"}`
          : cliModel !== "default"
            ? cliModel
            : undefined;
    const body = {
      message,
      contentParts: media.parts.length
        ? [
            ...(message ? [{ type: "text" as const, text: message }] : []),
            ...media.parts,
          ]
        : undefined,
      model,
      reasoningEffort,
      references,
    };
    if (isDraft)
      setDraftPreview({
        scope: viewKey,
        message,
        contentParts: body.contentParts,
      });
    try {
      if (isDraft) {
        const created =
          createdDraftRef.current ??
          (await submitSessionDraft(projectId, {
            ...body,
            backendId,
            permissionTier: cliBackend ? undefined : permissionTier,
            mode: acp ? "chat" : draftMode,
            prompt: message,
            gitWorkspace,
          }));
        if (isCurrent()) createdDraftRef.current = created;
        await sendSessionMessage(created.id, body);
        markSubmitted(created.id);
        if (isCurrent()) {
          createdDraftRef.current = null;
          navigate(sessionPath(projectId, created.id));
        }
      } else {
        await submitOrEnqueueSessionInput(session.id, body);
        markSubmitted(session.id);
      }
      if (!isDraft || isCurrent()) {
        setContent("");
        media.clear();
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
      if (isCurrent()) setDraftPreview(null);
    }
  }, [
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
    unavailableDraftAcp,
    isGenerating,
    queueWhileGenerating,
    backendId,
    providerId,
    modelId,
    cliModel,
    reasoningEffort,
    cliBackend,
    permissionTier,
    references,
    isDraft,
    projectId,
    acp,
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
      !["completed", "failed", "cancelled", "interrupted"].includes(
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
      if (backendId === "native" || backendId.endsWith("-acp")) {
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
        mode === "plan"
          ? t("sessionPlanPlaceholder")
          : mode === "goal"
            ? t("sessionGoalPlaceholder")
            : t("sessionComposePlaceholder")
      }
      keyboardHintPlacement={isCentered ? "tooltip" : "placeholder"}
      onOverlayOpenChange={setOverlayOpen}
      modelControl={
        backendId === "codex" || backendId === "claude-code" ? (
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
          <SessionModePicker
            mode={acp ? "chat" : mode}
            disabled={!modeEnabled}
            description={
              zh
                ? "模式与审批权限独立控制；运行中或有待处理请求时不可切换。"
                : "Mode and approval are independent; switching is disabled while busy or pending."
            }
            onChange={handleModeChange}
          />
          {isDraft && (
            <GitWorkspacePicker
              projectId={projectId}
              value={gitWorkspace ?? { kind: "default" }}
              disabled={submitting || Boolean(createdDraftRef.current)}
              onChange={setGitWorkspace}
            />
          )}
          {(isDraft || backendId !== "native") && (
            <SessionBackendPicker
              value={backendId}
              options={backendOptions}
              disabled={
                !isDraft || submitting || Boolean(createdDraftRef.current)
              }
              onChange={(id) => {
                setDraftBackendId(id);
                setError(null);
                if (id !== "native") {
                  setReferences((items) =>
                    items.filter(
                      (item) => item.kind === "file" || item.kind === "wiki",
                    ),
                  );
                  setSkillIds([]);
                }
              }}
            />
          )}
        </div>
      }
      projectId={projectId}
      backendId={backendId}
      content={content}
      onContentChange={setContent}
      onSubmit={() => void handleSubmit()}
      onStop={handleStop}
      isGenerating={isGenerating}
      isResumable={isResumable}
      onResume={isResumable ? handleResume : undefined}
      defaultExpanded={isCentered}
      providerId={providerId}
      modelId={modelId}
      onModelSelect={(selection) => {
        const selectedBackend =
          selection.kind === "acp" ? selection.providerId : "native";
        if (selectedBackend !== backendId) {
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
        });
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
      disabled={
        submitting ||
        editingQueue ||
        changingMode ||
        unavailableDraftAcp ||
        (isGenerating && !queueWhileGenerating)
      }
      wikiAttachDisabled={!isDraft}
      queueWhileGenerating={
        queueWhileGenerating && !submitting && !editingQueue && !changingMode
      }
    />
  );

  const composerShell = (
    <div
      className="agent-session-controls w-full"
      data-composer-mode={
        backendId !== "native" ? "chat" : mode === "plan_node" ? "plan" : mode
      }
    >
      {error && (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {error}
        </p>
      )}
      {unavailableDraftAcp && (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {zh
            ? "网关尚未发现此 ACP。请选择可用的执行后端。"
            : "The gateway has not discovered this ACP. Choose an available execution backend."}
        </p>
      )}
      {incompatibleModel && (
        <p role="alert" className="mb-2 px-2 text-xs text-danger">
          {zh
            ? "请选择当前后端的模型；切换执行后端需新建会话。"
            : "Choose a model for this backend; start a new session to change backends."}
        </p>
      )}
      {session && (
        <RuntimeRecoveryPanel
          key={`recovery-${session.id}`}
          session={session}
        />
      )}
      {session && !hasPendingClarificationInteractions && (
        <AgentInteractionPanel
          key={`interactions-${session.id}`}
          session={session}
          compact
        />
      )}
      {commands.menu}
      {isDraft && draftPreview?.scope === viewKey && (
        <div
          className="mx-auto max-h-[50vh] w-full max-w-3xl overflow-y-auto px-4 py-3"
          aria-label={zh ? "对话记录" : "Conversation history"}
        >
          <UserMessageBlock
            content={draftPreview.message}
            contentParts={draftPreview.contentParts}
          />
          <ThinkingIndicator />
        </div>
      )}
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
      <ComposerIsland
        sessionId={viewKey}
        running={session?.status === "running"}
        readingHistory={readingHistory}
        protectedInteraction={
          overlayOpen ||
          commands.overlayOpen ||
          hasPendingPermissions ||
          hasPendingInteractions ||
          Boolean(error) ||
          submitting ||
          editingQueue ||
          changingMode
        }
        onStop={handleStop}
      >
        <div
          className={`agent-session-composer-shell agent-dock-shell w-full flex flex-col items-center${isCentered ? " agent-session-composer-shell--draft" : ""}`}
          data-has-media={hasMediaInput ? "true" : "false"}
          data-multiline="true"
        >
          <div
            className="agent-dock-shell-content agent-composer-ask-switch"
            data-ask-active={hasPendingClarificationInteractions ? "true" : "false"}
          >
            <div
              className="agent-composer-input-slot"
              aria-hidden={hasPendingClarificationInteractions}
              inert={hasPendingClarificationInteractions ? true : undefined}
            >
              {composer}
            </div>
            {session && hasPendingClarificationInteractions && (
              <div className="agent-composer-ask-slot">
                <AgentInteractionPanel session={session} dock />
              </div>
            )}
          </div>
        </div>
      </ComposerIsland>
    </div>
  );

  return (
    <div
      className={
        isCentered
          ? "agent-session-composer--centered flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10"
          : isFocusRail
            ? "agent-session-composer agent-session-composer--focus-rail w-full shrink-0"
            : "agent-session-composer agent-session-composer--footer shrink-0 px-4 pb-4 pt-2"
      }
    >
      {isCentered ? (
        <div className="session-welcome-layout flex w-full max-w-3xl flex-col items-center gap-6">
          {draftPreview?.scope !== viewKey && (
            <NewSessionWelcome />
          )}
          <div className="w-full min-w-0">{composerShell}</div>
        </div>
      ) : (
        <div className="mx-auto w-full min-w-0 max-w-3xl">
          {statusSlot}
          {composerShell}
        </div>
      )}
    </div>
  );
}
