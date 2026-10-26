import "../../features/agent-workspace/sessionPerformance.css";
import "../../features/agent-workspace/workPage.css";
import { memo, useCallback, useEffect, useId, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import { useSessionDetailPolling } from "../../features/agent-workspace/useSessionDetailPolling";
import { useSessionLiveStream } from "../../features/agent-workspace/useSessionLiveStream";
import { hasRunRealtimeObservation } from "../../adapters/transport/runRealtime";
import { useLocale } from "../../shared/hooks/useLocale";
import { WorkQuickActions } from "../../features/agent-workspace/WorkQuickActions";
import { SessionTranscript } from "../../features/agent-workspace/SessionTranscript";
import { AgentCommandRail } from "../../features/agent-workspace/AgentCommandRail";

import { SessionWorkspacePanel } from "../../features/agent-workspace/SessionWorkspacePanel";
import { WorkspaceWidgetDock } from "../../features/agent-workspace/WorkspaceWidgetDock";
import { SubagentConversationPanel } from "../../features/agent-workspace/SubagentConversationPanel";
import { SideChatPanel } from "../../features/agent-workspace/SideChatPanel";
import { SessionListPanel } from "../../features/agent-workspace/SessionListPanel";
import { SessionComposer } from "../../features/agent-workspace/SessionComposer";
import { useSessionRouteSync } from "../../features/agent-workspace/useSessionRouteSync";
import {
  isNewSessionPath,
  newSessionPath,
} from "../../features/agent-workspace/sessionRoutes";
import type { SessionListView } from "../../features/agent-workspace/sessionBuckets";
import {
  useSessionWorkspace,
  useSessionWorkspaceStore,
} from "../../features/agent-workspace/state/sessionWorkspaceStore";
import {
  SessionSidePanel,
  type SessionSidePanelView,
} from "../../features/agent-workspace/SessionSidePanel";
import {
  MAIN_CONTENT_MIN,
  useResizablePanel,
} from "../../features/agent-workspace/useResizablePanel";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { useSideChatStore } from "../../features/agent-workspace/state/sideChatStore";

const LEFT_PANEL_DEFAULT = 260;
const LEFT_PANEL_MIN = 210;
const LEFT_PANEL_MAX = 420;
const RIGHT_PANEL_DEFAULT = 300;
const RIGHT_PANEL_MIN = 240;
const RIGHT_PANEL_MAX = 960;
const LEFT_PANEL_STORAGE_KEY = "synax-sessions-left-panel";
const RIGHT_PANEL_STORAGE_KEY = "synax-sessions-right-panel";
const SIDEBAR_VIEW_STORAGE_KEY = "synax-sessions-sidebar-view";

type SidebarView = "sessions" | "workspace";

function readSidebarView(): SidebarView {
  if (typeof window === "undefined") return "sessions";
  return window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "workspace"
    ? "workspace"
    : "sessions";
}

export default memo(function SessionsPage() {
  useSessionDetailPolling();
  const { t, locale } = useLocale();
  const sidePanelId = useId();
  const navigate = useNavigate();
  const { projectId = "" } = useParams();
  const leftPanel = useResizablePanel(
    "left",
    LEFT_PANEL_DEFAULT,
    LEFT_PANEL_MIN,
    LEFT_PANEL_MAX,
    LEFT_PANEL_STORAGE_KEY,
  );
  const widgetPanel = useResizablePanel(
    "right",
    RIGHT_PANEL_DEFAULT,
    RIGHT_PANEL_MIN,
    RIGHT_PANEL_MAX,
    RIGHT_PANEL_STORAGE_KEY,
  );
  const subagentPanel = useResizablePanel(
    "right",
    RIGHT_PANEL_DEFAULT,
    RIGHT_PANEL_MIN,
    RIGHT_PANEL_MAX,
    "synax-sessions-subagent-panel",
  );
  const sideChatPanel = useResizablePanel(
    "right",
    RIGHT_PANEL_DEFAULT,
    RIGHT_PANEL_MIN,
    RIGHT_PANEL_MAX,
    "synax-sessions-side-chat-panel",
  );
  const [sidebarView, setSidebarView] = useState<SidebarView>(readSidebarView);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, sidebarView);
    } catch {
      /* storage may be unavailable */
    }
  }, [sidebarView]);
  const location = useLocation();
  useEffect(() => {
    const toggle = () => {
      if (location.pathname.includes("/sessions"))
        leftPanel.setCollapsed((value) => !value);
    };
    document.addEventListener("menu:toggle-sidebar", toggle);
    return () => document.removeEventListener("menu:toggle-sidebar", toggle);
  }, [location.pathname, leftPanel.setCollapsed]);
  const listView: SessionListView = location.pathname.includes(
    "/sessions/workflows",
  )
    ? "workflow"
    : "sessions";

  useSessionRouteSync(listView, projectId);

  const [historyReading, setHistoryReading] = useState(false);
  const agentSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const agentPanelOpen = useAgentSessionStore((s) => s.panelOpen);
  const agentSessionStatus = useAgentSessionStore((s) => {
    const id = s.selectedSessionId;
    return id
      ? s.sessions.find((session) => session.id === id)?.status
      : undefined;
  });
  const agentSession = useAgentSessionStore((s) => {
    const id = s.selectedSessionId;
    return id ? s.sessions.find((session) => session.id === id) : undefined;
  });
  const workspaceState = useSessionWorkspace(agentSessionId);
  const selectedSubagent = workspaceState.subagent;
  const subagentFullscreen = Boolean(selectedSubagent?.fullscreen);
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [layoutWidth, setLayoutWidth] = useState(0);
  const sideChat = useSideChatStore((s) => agentSessionId ? s.chats[agentSessionId] : undefined);
  useEffect(() => {
    if (!layoutElement) return;
    const measure = () => setLayoutWidth(layoutElement.clientWidth);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(layoutElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [layoutElement]);
  const rightPanelMax =
    layoutWidth > 0
      ? Math.min(
          RIGHT_PANEL_MAX,
          Math.max(RIGHT_PANEL_MIN, layoutWidth - MAIN_CONTENT_MIN),
        )
      : RIGHT_PANEL_MAX;
  const hasWorkspaceContent = Boolean(workspaceState.activeTabId);
  const wideWorkspace = useMediaQuery("(min-width: 1280px)");
  const narrowWorkspace = useMediaQuery("(max-width: 767px)");
  useEffect(() => {
    widgetPanel.setCollapsed(!wideWorkspace);
  }, [wideWorkspace, widgetPanel.setCollapsed]);
  useEffect(() => {
    if (narrowWorkspace) leftPanel.setCollapsed(true);
  }, [narrowWorkspace, leftPanel.setCollapsed]);
  // A terminal session patch can arrive before the durable stream's final
  // message record. Keep that stream attached until it clears its realtime
  // ownership, then let the status-driven cleanup release it.
  const liveSession =
    agentPanelOpen &&
    agentSessionId &&
    (hasRunRealtimeObservation(agentSessionId) ||
      agentSessionStatus === "running" ||
      agentSessionStatus === "waiting_permission" ||
      agentSessionStatus === "waiting_input")
      ? agentSessionId
      : null;
  useSessionLiveStream(liveSession);

  const isNewDraft =
    listView === "sessions" && isNewSessionPath(location.pathname);
  const showTranscript = Boolean(agentPanelOpen && agentSessionId);
  const workspaceFullscreen =
    showTranscript &&
    hasWorkspaceContent &&
    workspaceState.presentation === "focus";
  const canCreateSession = listView === "sessions" && Boolean(projectId);
  const sideChatVisible = Boolean(
    showTranscript &&
    sideChat &&
    agentSession &&
    !workspaceFullscreen &&
    !selectedSubagent,
  );
  const openSideChat = useCallback(() => {
    if (agentSession) useSideChatStore.getState().start(agentSession);
  }, [agentSession]);

  const sidePanelViews: SessionSidePanelView[] = [
    {
      id: "widgets",
      label: locale === "zh" ? "工作组件" : "Work widgets",
      presentation: "inset",
      width: Math.min(widgetPanel.width, rightPanelMax),
      collapsed: widgetPanel.collapsed,
      resizing: widgetPanel.resizing,
      onResize: widgetPanel.startResize,
      onResizeKeyDown: widgetPanel.resizeWithKeyboard,
      content: (
        <WorkspaceWidgetDock sessionId={agentSessionId} scope={projectId} />
      ),
    },
  ];
  if (selectedSubagent && agentSessionId)
    sidePanelViews.push({
      id: "subagent",
      label: locale === "zh" ? "子代理会话" : "Subagent conversation",
      width: Math.min(subagentPanel.width, rightPanelMax),
      fullscreen: subagentFullscreen,
      resizing: subagentPanel.resizing,
      onResize: subagentPanel.startResize,
      onResizeKeyDown: subagentPanel.resizeWithKeyboard,
      content: (
        <SubagentConversationPanel
          ownerSessionId={agentSessionId}
          sessionId={selectedSubagent.sessionId}
          title={selectedSubagent.title}
        />
      ),
    });
  if (sideChat && agentSessionId)
    sidePanelViews.push({
      id: "side-chat",
      label: t("sideChatTitle"),
      width: Math.min(sideChatPanel.width, rightPanelMax),
      resizing: sideChatPanel.resizing,
      onResize: sideChatPanel.startResize,
      onResizeKeyDown: sideChatPanel.resizeWithKeyboard,
      content: (
        <SideChatPanel
          key={sideChat.requestId}
          ownerSessionId={agentSessionId}
        />
      ),
    });
  const activeSidePanelId = selectedSubagent
    ? "subagent"
    : sideChatVisible
      ? "side-chat"
      : !workspaceFullscreen
        ? "widgets"
        : null;
  const activeSidePanel = sidePanelViews.find(
    (view) => view.id === activeSidePanelId,
  );
  const sidePanelFullscreen = Boolean(activeSidePanel?.fullscreen);
  const commandRailLeft = leftPanel.collapsed ? 0 : leftPanel.width;
  const commandRailRight =
    showTranscript && !narrowWorkspace && activeSidePanel
      ? activeSidePanel.collapsed
        ? 0
        : activeSidePanel.width
      : 0;

  return (
    <div
      className="agent-page-shell work-page relative flex h-full min-h-0"
      data-subagent={showTranscript && selectedSubagent ? "true" : undefined}
      data-side-panel={activeSidePanel ? "true" : undefined}
      data-new-session-entry={
        location.state?.fromNewSession ? "true" : undefined
      }
    >
      <>
        <aside
          className={`session-panel-host session-panel-host--left relative shrink-0 ${leftPanel.collapsed ? "overflow-visible" : "overflow-hidden"}`}
          hidden={workspaceFullscreen || sidePanelFullscreen}
          data-collapsed={leftPanel.collapsed ? "true" : undefined}
          data-resizing={leftPanel.resizing ? "true" : undefined}
          style={{ width: leftPanel.collapsed ? 0 : leftPanel.width }}
        >
          <div
            className="h-full"
            inert={leftPanel.collapsed}
            aria-hidden={leftPanel.collapsed}
            style={{ width: leftPanel.width }}
          >
            <SessionListPanel
              listView={listView}
              projectId={projectId}
              onTogglePanel={() => leftPanel.setCollapsed((value) => !value)}
              collapsed={leftPanel.collapsed}
              toolbarVisible={!workspaceFullscreen && !sidePanelFullscreen}
              sidebarView={sidebarView}
              onSidebarViewChange={(view) => {
                setSidebarView(view);
                leftPanel.setCollapsed(false);
              }}
              hideHeaderActions
            />
            <div
              className="session-panel-resizer session-panel-resizer--left"
              onPointerDown={leftPanel.startResize}
              role="separator"
              aria-orientation="vertical"
            />
          </div>
        </aside>

        {showTranscript ? (
          <div
            ref={setLayoutElement}
            className="work-session-layout"
            data-side-panel-fullscreen={
              sidePanelFullscreen ? "true" : undefined
            }
          >
            <div
              className={`work-content-layout min-w-0 flex-1 flex-col overflow-hidden ${sidePanelFullscreen ? "hidden" : "flex"}`}
            >
              <div
                hidden={hasWorkspaceContent}
                className={
                  hasWorkspaceContent
                    ? "hidden"
                    : "flex min-h-0 flex-1 flex-col"
                }
              >
                <SessionTranscript
                  active={!hasWorkspaceContent}
                  onReadingHistoryChange={setHistoryReading}
                />
              </div>
              {hasWorkspaceContent && (
                <SessionWorkspacePanel
                  sessionId={agentSessionId}
                  mode="content"
                />
              )}
            </div>
            <SessionSidePanel
              id={sidePanelId}
              views={sidePanelViews}
              activeViewId={activeSidePanelId}
              minWidth={RIGHT_PANEL_MIN}
              maxWidth={rightPanelMax}
            />
          </div>
        ) : isNewDraft ? (
          <div className="work-content-layout flex min-w-0 flex-1 flex-col overflow-hidden">
            <SessionComposer projectId={projectId} layout="centered" />
          </div>
        ) : (
          <div className="work-content-layout flex min-w-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {canCreateSession
                ? t("sessionSelectOrCreate")
                : t("sessionSelectHint")}
            </p>
            {canCreateSession ? (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => navigate(newSessionPath(projectId))}
              >
                <Plus size={14} />
                {t("sessionNew")}
              </Button>
            ) : null}
          </div>
        )}
      </>
      {showTranscript && !selectedSubagent && !sideChatVisible ? (
        <WorkQuickActions
          expanded={activeSidePanelId === "widgets" && !widgetPanel.collapsed}
          controlsId={sidePanelId}
          onToggle={() => {
            if (workspaceFullscreen && agentSessionId) {
              useSessionWorkspaceStore.getState().exitFocus(agentSessionId);
              widgetPanel.setCollapsed(false);
            } else {
              widgetPanel.setCollapsed((value) => !value);
            }
          }}
        />
      ) : null}
      {showTranscript && agentSessionId ? (
        <AgentCommandRail
          hidden={hasWorkspaceContent || sidePanelFullscreen}
          sessionId={agentSessionId}
          readingHistory={historyReading}
          projectId={projectId}
          focus={false}
          onOpenSideChat={openSideChat}
          insetLeft={commandRailLeft}
          insetRight={commandRailRight}
        />
      ) : null}
    </div>
  );
});
