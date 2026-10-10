import "../../features/agent-workspace/sessionPerformance.css";
import "../../features/agent-workspace/workPage.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { WorkbenchIslandSlot } from "../layouts/WorkbenchIsland";
import { Dialog, DialogContainer, DialogPanel, DialogCloseButton, DialogHeader, DialogTitle, DialogBody } from "@/shared/ui/ui/Dialog";
import { Button } from "@/shared/ui/ui/Button";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import { useSessionDetailPolling } from "../../features/agent-workspace/useSessionDetailPolling";
import { useSessionLiveStream } from "../../features/agent-workspace/useSessionLiveStream";
import { useLocale } from "../../shared/hooks/useLocale";
import { WorkQuickActions } from "../../features/agent-workspace/WorkQuickActions";
import { SessionTranscript } from "../../features/agent-workspace/SessionTranscript";
import { AgentCommandRail } from "../../features/agent-workspace/AgentCommandRail";

import { SessionWorkspacePanel } from "../../features/agent-workspace/SessionWorkspacePanel";
import { WorkspaceWidgetDock } from "../../features/agent-workspace/WorkspaceWidgetDock";
import { SubagentConversationPanel } from "../../features/agent-workspace/SubagentConversationPanel";
import { SessionListPanel } from "../../features/agent-workspace/SessionListPanel";
import { SessionComposer } from "../../features/agent-workspace/SessionComposer";
import { SessionPanelCollapseButton } from "../../features/agent-workspace/SessionPanelCollapseButton";
import { useSessionRouteSync } from "../../features/agent-workspace/useSessionRouteSync";
import {
  isNewSessionPath,
  newSessionPath,
} from "../../features/agent-workspace/sessionRoutes";
import type { SessionListView } from "../../features/agent-workspace/sessionBuckets";
import { useSessionWorkspace } from "../../features/agent-workspace/state/sessionWorkspaceStore";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";

const LEFT_PANEL_DEFAULT = 260;
const LEFT_PANEL_MIN = 210;
const LEFT_PANEL_MAX = 420;
const RIGHT_PANEL_DEFAULT = 300;
const RIGHT_PANEL_MIN = 240;
const RIGHT_PANEL_MAX = 960;
const MAIN_CONTENT_MIN = 320;
const LEFT_PANEL_STORAGE_KEY = "synax-sessions-left-panel";
const RIGHT_PANEL_STORAGE_KEY = "synax-sessions-right-panel";

type PanelSide = "left" | "right";

function readPanelWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  // `Number(null)` is 0, which used to pin first-load panels to their minimum
  // width instead of the default. Only a real, non-empty value wins.
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function useResizablePanel(
  side: PanelSide,
  defaultWidth: number,
  min: number,
  max: number,
) {
  const storageKey =
    side === "left" ? LEFT_PANEL_STORAGE_KEY : RIGHT_PANEL_STORAGE_KEY;
  const [width, setWidth] = useState(() =>
    readPanelWidth(storageKey, defaultWidth, min, max),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    scale: number;
  } | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed && side === "left") return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      cleanupRef.current?.();
      setResizing(true);
      const panel = event.currentTarget.parentElement!;
      const scale =
        panel.getBoundingClientRect().width / panel.offsetWidth || 1;
      const startWidth = panel.offsetWidth || width;
      dragRef.current = { startX: event.clientX, startWidth, scale };
      const resizeMax = side === "right"
        ? Math.min(max, Math.max(min, (panel.parentElement?.clientWidth ?? max + MAIN_CONTENT_MIN) - MAIN_CONTENT_MIN))
        : max;
      let nextWidth = startWidth;
      let frame = 0;

      const handleMove = (move: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const delta =
          side === "left"
            ? move.clientX - drag.startX
            : drag.startX - move.clientX;
        nextWidth = Math.min(
          resizeMax,
          Math.max(min, drag.startWidth + delta / drag.scale),
        );
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            setWidth(nextWidth);
          });
      };
      const handleUp = () => {
        if (frame) cancelAnimationFrame(frame);
        setWidth(nextWidth);
        try {
          window.localStorage.setItem(storageKey, String(nextWidth));
        } catch {
          /* storage may be unavailable */
        }
        dragRef.current = null;
        setResizing(false);
        cleanupRef.current = null;
        window.removeEventListener("pointercancel", handleUp);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      cleanupRef.current = handleUp;
      window.addEventListener("pointercancel", handleUp);
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [collapsed, max, min, side, width, storageKey],
  );

  return { width, collapsed, resizing, setCollapsed, startResize };
}

export default memo(function SessionsPage() {
  useSessionDetailPolling();
  const { t, locale } = useLocale();
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const close = () => setDetailsOpen(false);
    document.addEventListener("terminal:open", close);
    return () => document.removeEventListener("terminal:open", close);
  }, []);
  const navigate = useNavigate();
  const { projectId = "" } = useParams();
  const leftPanel = useResizablePanel(
    "left",
    LEFT_PANEL_DEFAULT,
    LEFT_PANEL_MIN,
    LEFT_PANEL_MAX,
  );
  const rightPanel = useResizablePanel(
    "right",
    RIGHT_PANEL_DEFAULT,
    RIGHT_PANEL_MIN,
    RIGHT_PANEL_MAX,
  );
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
  const workspaceState = useSessionWorkspace(agentSessionId);
  const selectedSubagent = workspaceState.subagent;
  const subagentFullscreen = Boolean(selectedSubagent?.fullscreen);
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  useEffect(() => {
    if (!layoutElement) return;
    const measure = () => setLayoutWidth(layoutElement.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(layoutElement);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [layoutElement]);
  const rightPanelWidth = layoutWidth > 0
    ? Math.min(rightPanel.width, Math.max(RIGHT_PANEL_MIN, layoutWidth - MAIN_CONTENT_MIN))
    : rightPanel.width;
  const hasWorkspaceContent = Boolean(workspaceState.activeTabId);
  const wideWorkspace = useMediaQuery("(min-width: 1280px)");
  const narrowWorkspace = useMediaQuery("(max-width: 767px)");
  useEffect(() => {
    if (narrowWorkspace) leftPanel.setCollapsed(true);
  }, [narrowWorkspace, leftPanel.setCollapsed]);

  useEffect(
    () => setDetailsOpen(false),
    [
      agentSessionId,
      workspaceState.activeTabId,
      workspaceState.tabs,
      wideWorkspace,
    ],
  );

  const liveSession =
    agentPanelOpen &&
    (agentSessionStatus === "running" ||
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

  const commandRailLeft = leftPanel.collapsed ? 0 : leftPanel.width;
  const commandRailRight =
    showTranscript && !narrowWorkspace && (selectedSubagent || (wideWorkspace && !workspaceFullscreen))
      ? (selectedSubagent ? rightPanelWidth : rightPanel.collapsed ? 40 : rightPanelWidth)
      : 0;

  return (
    <div className="agent-page-shell work-page relative flex h-full min-h-0" data-subagent={showTranscript && selectedSubagent ? "true" : undefined} data-new-session-entry={location.state?.fromNewSession ? "true" : undefined}>
      <>
        <aside
          className={`session-panel-host session-panel-host--left relative shrink-0 ${leftPanel.collapsed ? "overflow-visible" : "overflow-hidden"}`}
          hidden={workspaceFullscreen || subagentFullscreen}
          data-collapsed={leftPanel.collapsed ? "true" : undefined}
          data-resizing={leftPanel.resizing ? "true" : undefined}
          style={{ width: leftPanel.collapsed ? 0 : leftPanel.width }}
        >
          {/* While the panel is open the control lives next to the SynaxCode
                title; the edge tab only exists to bring a collapsed panel back,
                so it carries the Synax brand mark instead of a bare chevron. */}
          {leftPanel.collapsed ? (
            <SessionPanelCollapseButton
              collapsed
              onToggle={() => leftPanel.setCollapsed((value) => !value)}
            />
          ) : null}
          <div
            className="h-full"
            inert={leftPanel.collapsed}
            aria-hidden={leftPanel.collapsed}
            style={{ width: leftPanel.width }}
          >
            <SessionListPanel
              listView={listView}
              projectId={projectId}
              onCollapsePanel={() => leftPanel.setCollapsed(true)}
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
          <div ref={setLayoutElement} className="work-session-layout" data-subagent-fullscreen={subagentFullscreen ? "true" : undefined}>
            <div className={`work-content-layout min-w-0 flex-1 flex-col overflow-hidden ${subagentFullscreen ? "hidden" : "flex"}`}>
              <WorkbenchIslandSlot placement="conversation" />
              {agentSessionId && (
                <WorkQuickActions
                  showDetailsButton={!wideWorkspace || workspaceFullscreen}
                  onShowDetails={() => setDetailsOpen(true)}
                />
              )}
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
            {selectedSubagent && agentSessionId ? (
              <aside className="subagent-conversation-panel" data-fullscreen={subagentFullscreen ? "true" : undefined} style={!narrowWorkspace && !subagentFullscreen ? { width: rightPanelWidth } : undefined}>
                {!subagentFullscreen && <div className="session-panel-resizer session-panel-resizer--right" onPointerDown={rightPanel.startResize} role="separator" aria-orientation="vertical" />}
                <SubagentConversationPanel ownerSessionId={agentSessionId} sessionId={selectedSubagent.sessionId} title={selectedSubagent.title} />
              </aside>
            ) : wideWorkspace && !workspaceFullscreen ? (
              <WorkspaceWidgetDock
                sessionId={agentSessionId}
                scope={projectId}
                width={rightPanelWidth}
                onResize={rightPanel.startResize}
                collapsed={rightPanel.collapsed}
                resizing={rightPanel.resizing}
                onToggle={() => rightPanel.setCollapsed((value) => !value)}
              />
            ) : null}
          </div>
        ) : isNewDraft ? (
          <div className="work-content-layout flex min-w-0 flex-1 flex-col overflow-hidden">
            <WorkbenchIslandSlot placement="conversation" />
            <SessionComposer projectId={projectId} layout="centered" />
          </div>
        ) : (
          <div className="work-content-layout flex min-w-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <WorkbenchIslandSlot placement="conversation" />
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
      <Dialog open={detailsOpen} onClose={() => (setDetailsOpen)(false)}>
        <DialogContainer size="sm">
          <DialogPanel className="work-details-dialog">
            <DialogCloseButton />
            <DialogHeader>
              <DialogTitle>
                {locale === "zh" ? "任务详情" : "Task details"}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <SessionWorkspacePanel
                sessionId={agentSessionId}
                mode="dashboard"
              />
            </DialogBody>
          </DialogPanel>
        </DialogContainer>
      </Dialog>
      {showTranscript && agentSessionId ? (
        <AgentCommandRail
          hidden={hasWorkspaceContent || subagentFullscreen}
          sessionId={agentSessionId}
          readingHistory={historyReading}
          projectId={projectId}
          focus={false}
          insetLeft={commandRailLeft}
          insetRight={commandRailRight}
        />
      ) : null}
    </div>
  );
});
