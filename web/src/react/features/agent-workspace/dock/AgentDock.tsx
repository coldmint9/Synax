import { useWikiStore } from "../../../state/wikiStore";
import { useMediaDraft } from "../../media/useMediaDraft";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";
import { useLocale } from "../../../../hooks/useLocale";
import { useConfig } from "../../settings/useConfig";
import { useAgentDockStore } from "../state/agentDockStore";
import { AgentComposer } from "../composer/AgentComposer";
import { effectiveReasoningEfforts } from "../../settings/lib/providerPresets";
import { AgentDockDialog } from "./AgentDockDialog";
import { AgentDockCollapsed } from "./AgentDockCollapsed";
import { AgentDockPrompt } from "./AgentDockPrompt";
import { AgentDockPreview } from "./AgentDockPreview";
import { listPendingPermissions } from "./AgentQuickApproval";
import { dockStateToMorph } from "./dockTypes";
import {
  buildAgentModelOptions,
  pickDefaultModelSelection,
} from "../composer/modelSelection";
import { useAcpDiscovery } from "../composer/useAcpDiscovery";
import {
  isDockSessionActive,
  resolveDockSessionTitle,
} from "./dockSessionStream";
import { useAgentDockBridge } from "./useAgentDockBridge";
import {
  EMPTY_INPUT_QUEUE,
  useAgentSessionStore,
} from "../state/agentSessionStore";
import { sessionPath } from "../sessionRoutes";
import { resolveSessionsEntryPath } from "../sessionLastVisit";
import { InputQueueStrip } from "../InputQueueStrip";

interface Props {
  projectId: string;
}

export function AgentDock({ projectId }: Props) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { providers, globalConfig, effectiveConfig } = useConfig(projectId);
  const acpDiscovery = useAcpDiscovery();

  const dockState = useAgentDockStore((s) => s.dockState);
  const setDockState = useAgentDockStore((s) => s.setDockState);
  const media = useMediaDraft(projectId, (parts) =>
    useAgentDockStore.setState({ composerContentParts: parts }),
  );
  const storedMediaParts = useAgentDockStore((s) => s.composerContentParts);
  useEffect(() => {
    if (storedMediaParts?.length === 0 && media.parts.length) media.clear();
  }, [storedMediaParts]);
  const content = useAgentDockStore((s) => s.composerContent);
  const setContent = useAgentDockStore((s) => s.setComposerContent);
  const providerId = useAgentDockStore((s) => s.composerProviderId);
  const setProviderId = useAgentDockStore((s) => s.setComposerProviderId);
  const modelId = useAgentDockStore((s) => s.composerModelId);
  const setModelId = useAgentDockStore((s) => s.setComposerModelId);
  const documentId = useAgentDockStore((s) => s.composerDocumentId);
  const setDocumentId = useAgentDockStore((s) => s.setComposerDocumentId);
  const wikiAttachMode = useAgentDockStore((s) => s.composerWikiAttachMode);
  const setWikiAttachMode = useAgentDockStore(
    (s) => s.setComposerWikiAttachMode,
  );
  const skillIds = useAgentDockStore((s) => s.composerSkillIds);
  const setSkillIds = useAgentDockStore((s) => s.setComposerSkillIds);
  const reasoningEffort = useAgentDockStore((s) => s.composerReasoningEffort);
  const setReasoningEffort = useAgentDockStore(
    (s) => s.setComposerReasoningEffort,
  );
  const allowedReasoningEfforts = providerId
    ? effectiveReasoningEfforts(globalConfig, providerId)
    : undefined;
  const permissionTier = useAgentDockStore((s) => s.composerPermissionTier);
  const setPermissionTier = useAgentDockStore((s) => s.setPermissionTier);
  const documents = useWikiStore((s) => s.documents);
  const goals = useWikiStore((s) => s.goals);
  const submitSession = useAgentDockStore((s) => s.submitSession);
  const stopSession = useAgentDockStore((s) => s.stopSession);
  const replyPermission = useAgentDockStore((s) => s.replyPermission);
  const session = useAgentDockStore((s) => s.session);
  const loadInputQueue = useAgentSessionStore((s) => s.loadInputQueue);
  const removeQueuedInput = useAgentSessionStore((s) => s.removeQueuedInput);
  const forceQueuedInput = useAgentSessionStore((s) => s.forceQueuedInput);
  const queuedInputs = useAgentSessionStore((s) =>
    session.sessionId
      ? (s.inputQueues[session.sessionId] ?? EMPTY_INPUT_QUEUE)
      : EMPTY_INPUT_QUEUE,
  );

  useAgentDockBridge(projectId);

  useEffect(() => {
    if (!session.sessionId) return;
    void loadInputQueue(session.sessionId);
  }, [session.sessionId, loadInputQueue]);

  const [miniHovered, setMiniHovered] = useState(false);
  const dockOverlayRef = useRef(false);
  const hitRef = useRef<HTMLDivElement>(null);
  const composeLayerRef = useRef<HTMLDivElement>(null);
  const [composeHeight, setComposeHeight] = useState<number | null>(null);

  // The shell morphs between the fixed pill height and the composer height, so
  // `height: auto` cannot be used as a transition endpoint. Keep the composer
  // mounted at all times and publish its natural height as a CSS variable; the
  // layer is clamped to max-height: 0 while hidden, which leaves scrollHeight
  // intact, and the composer child keeps its natural box so the observer still
  // fires while the layer itself is collapsed.
  useLayoutEffect(() => {
    const layer = composeLayerRef.current;
    if (!layer) return;
    const measure = () => {
      const height = layer.scrollHeight;
      setComposeHeight((previous) => (previous === height ? previous : height));
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(layer);
    const composer = layer.firstElementChild;
    if (composer) observer?.observe(composer);
    return () => observer?.disconnect();
  }, []);

  const morph = dockStateToMorph(dockState);
  const isBar = dockState === "idle";
  const isPrompt = dockState === "prompt";
  const isMini = dockState === "working";
  const isCompose = dockState === "input";
  const isChat = dockState === "expanded";

  const hasActiveWork = isDockSessionActive(session.status);
  const hasSession = Boolean(session.sessionId) && session.status !== "idle";
  const hasPendingGoals = goals.length > 0;
  const latestTool = session.toolCalls[session.toolCalls.length - 1];
  const isGenerating = session.status === "running";
  const queueWhileGenerating =
    Boolean(session.sessionId) &&
    (session.status === "running" || session.status === "waiting_permission");

  const sessionDisplayTitle = resolveDockSessionTitle(
    session,
    t("agentWorking"),
  );
  const pendingPermissions = listPendingPermissions(session.permissions);
  const hasPendingApproval = pendingPermissions.length > 0;
  const isComposerMultiline = content.includes("\n");
  const isDismissible = isChat || isCompose || isPrompt;

  const handleReplyPermission = useCallback(
    (permissionId: string, reply: "once" | "always" | "reject") => {
      return replyPermission(permissionId, reply);
    },
    [replyPermission],
  );

  const dismissDock = useCallback(() => {
    if (dockOverlayRef.current) return;
    const root = hitRef.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root?.contains(active)) {
      active.blur();
    }
    if (isChat) {
      setDockState(hasActiveWork ? "working" : "idle");
      return;
    }
    if (isCompose || isPrompt) {
      setDockState("idle");
    }
  }, [hasActiveWork, isChat, isCompose, isPrompt, setDockState]);

  const isOutsideDismissTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) return false;
    const root = hitRef.current;
    if (!root || root.contains(target)) return false;
    const el = target instanceof Element ? target : target.parentElement;
    if (el?.closest('[role="menu"], [role="listbox"], [data-slot="popover"]'))
      return false;
    return true;
  }, []);

  const handleOverlayOpenChange = useCallback((open: boolean) => {
    dockOverlayRef.current = open;
  }, []);

  useEffect(() => {
    if (!globalConfig) return;
    if (providerId && modelId) return;
    const { apiModels, acpEndpoints } = buildAgentModelOptions(
      globalConfig,
      providers,
      acpDiscovery,
    );
    const preferred = effectiveConfig
      ? {
          providerId: effectiveConfig.providerId,
          modelId: effectiveConfig.modelId,
        }
      : null;
    const picked = pickDefaultModelSelection(
      apiModels,
      acpEndpoints,
      preferred,
    );
    if (picked) {
      setProviderId(picked.providerId);
      setModelId(picked.modelId);
    }
  }, [
    globalConfig,
    providers,
    acpDiscovery,
    effectiveConfig,
    providerId,
    modelId,
    setProviderId,
    setModelId,
  ]);

  useEffect(() => {
    if (hasActiveWork && (isBar || isPrompt)) {
      setDockState("working");
    }
  }, [hasActiveWork, isBar, isPrompt, setDockState]);

  const openPromptFromBar = useCallback(() => {
    if (!isBar || hasActiveWork) return;
    setDockState("prompt");
  }, [hasActiveWork, isBar, setDockState]);

  const handleBarEnter = useCallback(() => {
    openPromptFromBar();
  }, [openPromptFromBar]);

  useEffect(() => {
    if (!isDismissible) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!isOutsideDismissTarget(e.target)) return;
      dismissDock();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isDismissible, dismissDock, isOutsideDismissTarget]);

  useEffect(() => {
    if (!isDismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isChat) {
        setDockState(hasActiveWork ? "working" : "idle");
      } else {
        setDockState("idle");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDismissible, isChat, hasActiveWork, setDockState]);

  const openSessionPage = useCallback(() => {
    const sessionId = session.sessionId;
    if (sessionId) {
      navigate(sessionPath(projectId, sessionId));
    } else {
      navigate(resolveSessionsEntryPath(projectId));
    }
  }, [session.sessionId, navigate, projectId]);

  const hitMode = isChat
    ? "dialog"
    : isCompose
      ? hasSession
        ? "composer-active"
        : "composer"
      : isPrompt || isMini
        ? "mini"
        : "bar";

  const showContextDialog =
    isChat || (isCompose && hasPendingApproval && hasSession);

  const composer = (
    <AgentComposer
      media={media}
      sessionId={session.sessionId ?? undefined}
      projectId={projectId}
      content={content}
      onContentChange={setContent}
      onSubmit={() => {
        if (!media.ready) return;
        void submitSession(projectId).then(() => {
          if (!useAgentDockStore.getState().composerContentParts?.length)
            media.clear();
        });
      }}
      onStop={stopSession}
      isGenerating={isGenerating}
      providerId={providerId}
      modelId={modelId}
      onModelSelect={(selection) => {
        setProviderId(selection.providerId);
        setModelId(selection.modelId);
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
      reasoningEffort={reasoningEffort}
      onReasoningEffortChange={setReasoningEffort}
      allowedReasoningEfforts={allowedReasoningEfforts}
      permissionTier={permissionTier}
      onPermissionTierChange={setPermissionTier}
      disabled={isGenerating && !queueWhileGenerating}
      queueWhileGenerating={queueWhileGenerating}
      onOverlayOpenChange={handleOverlayOpenChange}
    />
  );

  return (
    <>
      {isChat && (
        <div
          className="absolute inset-0 z-20 bg-background/25 backdrop-blur-[1px]"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault();
            dismissDock();
          }}
        />
      )}

      <div className="agent-dock-zone absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-3 sm:px-6">
        <div
          ref={hitRef}
          className="agent-dock-hit"
          data-hit={hitMode}
          onMouseEnter={isBar ? handleBarEnter : undefined}
        >
          <div
            className="agent-dock-morph flex flex-col items-center"
            data-morph={morph}
            data-awaiting-permission={hasPendingApproval ? "true" : undefined}
            style={
              composeHeight
                ? ({
                    "--agent-compose-h": `${composeHeight}px`,
                  } as CSSProperties)
                : undefined
            }
          >
            {showContextDialog && (
              <div className="agent-dock-dialog-slot mb-2.5 w-full">
                <AgentDockDialog
                  status={session.status}
                  sessionTitle={sessionDisplayTitle}
                  toolCalls={session.toolCalls}
                  thinking={session.streamingThinking}
                  streamingText={session.streamingText}
                  isRunning={isGenerating}
                  error={session.error}
                  permissions={session.permissions}
                  onReplyPermission={handleReplyPermission}
                  onOpenSession={isChat ? openSessionPage : undefined}
                />
              </div>
            )}

            <div className="agent-dock-stack flex w-full flex-col items-center">
              {isCompose && hasSession && !hasPendingApproval && (
                <AgentDockPreview
                  status={session.status}
                  latestTool={latestTool}
                  thinkingPreview={session.streamingThinking}
                  sessionTitle={sessionDisplayTitle}
                  onClick={() => setDockState("expanded")}
                />
              )}

              {session.sessionId && (isCompose || isChat) && (
                <InputQueueStrip
                  items={queuedInputs}
                  onRemove={(itemId) =>
                    void removeQueuedInput(session.sessionId!, itemId)
                  }
                  onForce={(itemId) =>
                    void forceQueuedInput(session.sessionId!, itemId)
                  }
                />
              )}

              <div
                className={`agent-dock-shell w-full${hasPendingGoals && isBar ? " agent-dock-shell--pending" : ""}`}
                data-shell={morph}
                data-multiline={
                  (isCompose || isChat) && isComposerMultiline
                    ? "true"
                    : undefined
                }
              >
                <div
                  className="agent-dock-mini-layer"
                  aria-hidden={!isPrompt && !isMini ? true : undefined}
                  inert={!isPrompt && !isMini}
                >
                  {isPrompt && (
                    <AgentDockPrompt
                      label={t("agentSoulPrompt")}
                      hovered={miniHovered}
                      onClick={() => setDockState("input")}
                      onMouseEnter={() => setMiniHovered(true)}
                      onMouseLeave={() => setMiniHovered(false)}
                    />
                  )}

                  {isMini && (
                    <AgentDockCollapsed
                      status={session.status}
                      toolCalls={session.toolCalls}
                      thinking={session.streamingThinking}
                      sessionTitle={sessionDisplayTitle}
                      permissions={session.permissions}
                      onReplyPermission={handleReplyPermission}
                      hovered={miniHovered}
                      onClick={() => setDockState("expanded")}
                      onMouseEnter={() => setMiniHovered(true)}
                      onMouseLeave={() => setMiniHovered(false)}
                    />
                  )}
                </div>

                <div
                  ref={composeLayerRef}
                  className="agent-dock-shell-content"
                  aria-hidden={!(isCompose || isChat) ? true : undefined}
                  inert={!(isCompose || isChat)}
                >
                  {composer}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
