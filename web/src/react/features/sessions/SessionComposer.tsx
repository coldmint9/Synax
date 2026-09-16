import { useSessionComposerSelection } from "./useSessionComposerSelection";
import { useMediaDraft } from "../media/useMediaDraft";
import { ComposerIsland } from "./ComposerIsland";
import { useComposerCommands } from "./useComposerCommands";
import type { GitWorkspaceSelection, TurnReference } from "../../../lib/api/agentRuntime";
import { NativeBackendModelPicker } from "./NativeBackendModelPicker";
import { RuntimeRecoveryPanel } from "./RuntimeRecoveryPanel";
import { agentRuntimeApi, type BackendId } from "../../../lib/api/agentRuntime";
import { SessionBackendPicker } from "./SessionBackendPicker";
import { GitWorkspacePicker } from "./GitWorkspacePicker";
import { readSessionBackendId } from "./synaxSessionTypes";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EMPTY_INPUT_QUEUE, useAgentSessionStore } from "./agentSessionStore";
import { useConfig } from "../settings/useConfig";
import { useWikiStore } from "../../state/wikiStore";
import { useLocale } from "../../../hooks/useLocale";
import { GoalComposerPill } from "../wiki/goal/GoalComposerPill";
import {
  discoveredAcpProviders,
  formatTurnModel,
} from "../wiki/goal/goalModelOptions";
import { useAcpDiscovery } from "../wiki/goal/useAcpDiscovery";
import { sessionPath } from "./sessionRoutes";
import {
  isSessionComposerLocked,
  sessionHasPendingPermissions,
  canEnqueueSessionInput,
  canSwitchSessionMode,
  isSessionResumable,
} from "./sessionComposerState";
import { InputQueueStrip } from "./InputQueueStrip";
import type {
  AgentSession,
  AgentSessionMode,
  ReasoningEffort,
} from "../../../lib/api/agentRuntime";
import { AgentInteractionPanel } from "./AgentInteractionPanel";
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
  const [content, setContent] = useState("");
  const [gitWorkspace, setGitWorkspace] = useState<GitWorkspaceSelection>();
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftMode = useAgentSessionStore((s) => s.draftMode);
  const setDraftMode = useAgentSessionStore((s) => s.setDraftMode);
  const updateSessionMode = useAgentSessionStore((s) => s.updateSessionMode);
  const interactionState = useAgentSessionStore((s) => s.interactionState);
  const sendSessionMessage = useAgentSessionStore((s) => s.sendSessionMessage);
  const submitOrEnqueueSessionInput = useAgentSessionStore(
    (s) => s.submitOrEnqueueSessionInput,
  );
  const loadInputQueue = useAgentSessionStore((s) => s.loadInputQueue);
  const removeQueuedInput = useAgentSessionStore((s) => s.removeQueuedInput);
  const forceQueuedInput = useAgentSessionStore((s) => s.forceQueuedInput);
  const sessionId = session?.id;
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
  const media = useMediaDraft(projectId);
  const hasMediaInput = media.parts.length > 0;
  const [references, setReferences] = useState<TurnReference[]>([]);
  const createdDraftRef = useRef<AgentSession | null>(null);
  useEffect(() => {
    setReferences([]);
    setGitWorkspace(undefined);
    createdDraftRef.current = null;
  }, [sessionId, projectId]);
  const isDraft = !session;
  const currentInteractions =
    interactionState?.sessionId === sessionId ? interactionState : null;
  const pendingInteractions =
    currentInteractions?.items.filter((item) => item.status === "pending") ??
    [];
  const hasPendingInteractions = pendingInteractions.length > 0;
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
    setError(null);
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
  const acpDiscovery = useAcpDiscovery({ enabled: isDraft });
  const availableAcp = discoveredAcpProviders(providers, acpDiscovery);
  const [draftBackendId, setDraftBackendId] = useState<BackendId>(() => {
    const previous = useWikiStore.getState().goalComposerProviderId;
    return previous?.endsWith("-acp") ? (previous as BackendId) : "native";
  });
  const backendId = session ? readSessionBackendId(session) : draftBackendId;
  const unavailableDraftAcp = isDraft && backendId.endsWith("-acp")
    && !availableAcp.some(provider => provider.id === backendId);
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
  const backendOptions = [
    { id: "native" as BackendId, label: "Synax" },
    ...backendCatalog
      .filter((backend) => backend.kind === "cli")
      .map((backend) => ({
        id: backend.id,
        label: `${backend.label}${backend.experimental ? " · Preview" : ""}`,
      })),
    ...availableAcp
      .map((provider) => ({
        id: provider.id as BackendId,
        label: provider.label ?? provider.id,
      })),
  ];
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
  }, [zh]);
  useEffect(() => {
    setCliEfforts(undefined);
  }, [session?.id, backendId]);

  const { providerId, modelId, cliModel, reasoningEffort, setSelection } = useSessionComposerSelection(
    projectId, session, backendId, globalConfig, providers, effectiveConfig,
  );
  const setCliModel = useCallback((cliModel: string) => setSelection({ cliModel }), [setSelection]);
  const setReasoningEffort = useCallback((reasoningEffort: ReasoningEffort) => setSelection({ reasoningEffort }), [setSelection]);
  const permissionTier = useWikiStore((s) => s.goalComposerPermissionTier);
  const wikiAttachMode = useWikiStore((s) => s.goalComposerWikiAttachMode);
  const setWikiAttachMode = useWikiStore(
    (s) => s.setGoalComposerWikiAttachMode,
  );
  const documentId = useWikiStore((s) => s.goalComposerDocumentId);
  const setDocumentId = useWikiStore((s) => s.setGoalComposerDocumentId);
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
    void loadProjectSnapshot(projectId);
  }, [loadProjectSnapshot, projectId]);

  useEffect(() => {
    if (!session) return;
    const tier = readSynaxPermissionTier(session.sessionMetadata);
    // Local-only sync — do not call setGoalPermissionTier (it PATCHes goalSession and loops).
    if (useWikiStore.getState().goalComposerPermissionTier === tier) return;
    useWikiStore.setState({ goalComposerPermissionTier: tier });
  }, [session?.id, session?.sessionMetadata]);

  const handlePermissionTierChange = useCallback(
    (tier: SynaxPermissionTier) => {
      if (useWikiStore.getState().goalComposerPermissionTier !== tier) {
        useWikiStore.setState({ goalComposerPermissionTier: tier });
      }
      if (sessionId) {
        void updateSessionPermissions(sessionId, { permissionTier: tier });
      }
    },
    [sessionId, updateSessionPermissions],
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
      submitting ||
      changingMode ||
      incompatibleModel ||
      unavailableDraftAcp ||
      (isGenerating && !queueWhileGenerating)
    )
      return;
    setError(null);
    setSubmitting(true);
    const model =
      backendId === "native"
        ? formatTurnModel(providerId, modelId)
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
      permissionTier: cliBackend ? undefined : permissionTier,
      references,
    };
    try {
      if (isDraft) {
        const created =
          createdDraftRef.current ??
          (await submitSessionDraft(projectId, {
            ...body,
            backendId,
            mode: acp ? "chat" : draftMode,
            prompt: message,
            gitWorkspace,
          }));
        createdDraftRef.current = created;
        await sendSessionMessage(created.id, body);
        createdDraftRef.current = null;
        navigate(sessionPath(projectId, created.id));
      } else {
        await submitOrEnqueueSessionInput(session.id, body);
      }
      setContent("");
      media.clear();
      setReferences([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [
    media,
    content,
    submitting,
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
    navigate,
    submitOrEnqueueSessionInput,
    session,
  ]);

  const commands = useComposerCommands({
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
    disabled:
      submitting || changingMode || (isGenerating && !queueWhileGenerating),
  });

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
    <GoalComposerPill
      media={media}
      sessionId={sessionId ?? undefined}
      inputModel={
        cliBackend ? (cliModel === "default" ? undefined : cliModel) : undefined
      }
      commands={commands}
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
          {isDraft && (
            <GitWorkspacePicker
              projectId={projectId}
              value={gitWorkspace ?? { kind: "default" }}
              disabled={submitting || Boolean(createdDraftRef.current)}
              onChange={setGitWorkspace}
            />
          )}
          <SessionBackendPicker
            value={backendId}
            options={backendOptions}
            disabled={!isDraft || submitting || Boolean(createdDraftRef.current)}
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
        setSelection({ providerId: selection.providerId, modelId: selection.modelId });
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
        submitting || changingMode || unavailableDraftAcp || (isGenerating && !queueWhileGenerating)
      }
      wikiAttachDisabled={!isDraft}
      queueWhileGenerating={
        queueWhileGenerating && !submitting && !changingMode
      }
    />
  );

  const composerShell = (
    <div className="agent-session-controls w-full">
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
      {session && <AgentInteractionPanel key={session.id} session={session} />}
      {commands.menu}
      <ComposerIsland
        key={`composer-${sessionId ?? "draft"}`}
        sessionId={sessionId}
        running={session?.status === "running"}
        readingHistory={readingHistory}
        protectedInteraction={
          overlayOpen ||
          commands.overlayOpen ||
          hasPendingPermissions ||
          hasPendingInteractions ||
          Boolean(error) ||
          submitting ||
          changingMode
        }
        onStop={handleStop}
      >
        <div
          className={`goal-session-composer-shell goal-dock-shell w-full flex flex-col items-center${isCentered ? " goal-session-composer-shell--draft" : ""}`}
          data-has-media={hasMediaInput ? "true" : "false"}
          data-multiline="true"
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
      </ComposerIsland>
    </div>
  );

  return (
    <div
      className={
        isCentered
          ? "goal-session-composer--centered flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10"
          : isFocusRail
            ? "goal-session-composer goal-session-composer--focus-rail w-full shrink-0"
            : "goal-session-composer goal-session-composer--footer shrink-0 px-4 pb-4 pt-2"
      }
    >
      {isCentered ? (
        <div className="flex w-full max-w-3xl flex-col items-center gap-6">
          <div className="max-w-lg text-center">
            <h2 className="text-lg font-medium text-foreground">
              {t("sessionDraftTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("sessionDraftHint")}
            </p>
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
  );
}
