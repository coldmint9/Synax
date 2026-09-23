import { refreshWorkspace } from "./workspaceRefresh";
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  MessageSquare,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { useContextMenu } from "../../components/context-menu/ContextMenuProvider";
import { fileContextEntries } from "./workspaceContextMenus";
import { handleError } from "../../../lib/errors";
import type { SessionEnvironment } from "../../../lib/api/agentRuntime";
import { FileTypeIcon } from "./FileTypeIcon";
import { useSessionWorkspaceEnvironment } from "./SessionEnvironmentContext";
import {
  useSessionWorkspace,
  saveWorkspaceTab,
  useSessionWorkspaceStore,
  type WorkspaceTab,
} from "./state/sessionWorkspaceStore";

function tabIcon(tab: WorkspaceTab) {
  switch (tab.kind) {
    case "file":
    case "input":
    case "diff":
      return <FileTypeIcon path={tab.path ?? tab.title} size={11} />;
    case "subagent":
      return <Bot size={11} className="shrink-0 text-[var(--color-run)]/80" />;
  }
}

function WorkspaceTabItem({ tab, active, sessionId, activeRef, environment, activate, close, closeOthers, canCloseOthers }: {
  tab: WorkspaceTab;
  active: boolean;
  sessionId: string;
  activeRef: React.Ref<HTMLDivElement>;
  environment: SessionEnvironment | null;
  activate: () => void;
  close: () => void;
  closeOthers: () => void;
  canCloseOthers: boolean;
}) {
  const { t } = useLocale();
  const root = environment?.repositories?.find((item) => item.rootId === tab.rootId)
    ?? environment?.repositories?.find((item) => item.role === "primary");
  const workspacePath = root?.workspacePath ?? environment?.workspacePath;
  const fileStatus = (root?.changedFiles ?? environment?.changedFiles)?.find((item) => item.path === tab.path)?.status;
  const fileExists = tab.kind === "file" || (tab.kind === "diff" && Boolean(fileStatus && fileStatus !== "deleted"));
  const menu = useContextMenu(() => ({ label: tab.title, entries: [
    { type: "action", id: "close", label: t("contextCloseTab"), restoreFocus: false, run: close },
    ...(canCloseOthers ? [{ type: "action" as const, id: "close-others", label: t("contextCloseOthers"), restoreFocus: false, run: closeOthers }] : []),
    ...(tab.path && (tab.kind === "file" || tab.kind === "diff")
      ? [{ type: "separator" as const }, ...fileContextEntries({ t, path: tab.path, workspacePath, canOpenFile: fileExists })]
      : []),
  ] }));
  return <div ref={active ? activeRef : undefined} className={`workspace-tab-item ${active ? "workspace-tab-item--active" : ""}`} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown}>
    <button type="button" role="tab" className="workspace-tab-main" aria-selected={active} title={tab.path ?? tab.title} onClick={activate} aria-haspopup="menu">
      {tabIcon(tab)}<span>{tab.title}</span>
    </button>
    <button type="button" className="workspace-tab-close" aria-label={t("workspaceCloseTab", { title: tab.title })} title={t("workspaceCloseTab", { title: tab.title })} onClick={close}><X size={9} /></button>
  </div>;
}

export function WorkspaceTabStrip({ sessionId }: { sessionId: string | null }) {
  const { t, locale } = useLocale();
  const { tabs, activeTabId, presentation } = useSessionWorkspace(sessionId);
  const { environment, loading, reload } = useSessionWorkspaceEnvironment(sessionId);
  const activateTab = useSessionWorkspaceStore((state) => state.activateTab);
  const closeTab = useSessionWorkspaceStore((state) => state.closeTab);
  const setPresentation = useSessionWorkspaceStore(
    (state) => state.setPresentation,
  );
  const activeRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const focused = presentation === "focus";
  const [pendingClose, setPendingClose] = useState<WorkspaceTab | null>(null);
  const [savingClose, setSavingClose] = useState(false);
  const closeQueue = useRef<{ ids: string[]; keepId?: string } | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  if (!sessionId || !activeTab) return null;

  const advanceCloseQueue = () => {
    if (!sessionId) return;
    const queue = closeQueue.current;
    if (!queue) return;
    while (queue.ids.length > 0) {
      const id = queue.ids.shift()!;
      const tab = useSessionWorkspaceStore.getState().sessions[sessionId]?.tabs.find((item) => item.id === id);
      if (!tab) continue;
      if (tab.dirty) { setPendingClose(tab); return; }
      closeTab(sessionId, id);
    }
    if (queue.keepId) activateTab(sessionId, queue.keepId);
    closeQueue.current = null;
    setPendingClose(null);
  };
  const close = (tab: WorkspaceTab) => {
    closeQueue.current = { ids: [tab.id] };
    advanceCloseQueue();
  };
  const closeOthers = (tab: WorkspaceTab) => {
    closeQueue.current = { ids: tabs.filter((item) => item.id !== tab.id).map((item) => item.id), keepId: tab.id };
    advanceCloseQueue();
  };
  const discardAndClose = () => {
    if (!pendingClose || !sessionId) return;
    closeTab(sessionId, pendingClose.id);
    setPendingClose(null);
    advanceCloseQueue();
  };
  const saveAndClose = async () => {
    if (!pendingClose || !sessionId) return;
    setSavingClose(true);
    let saved = false;
    try { saved = await saveWorkspaceTab(pendingClose.id); }
    catch (error) { handleError(error); }
    finally { setSavingClose(false); }
    if (!saved) return;
    closeTab(sessionId, pendingClose.id);
    setPendingClose(null);
    advanceCloseQueue();
  };
  const cancelClose = () => { closeQueue.current = null; setPendingClose(null); };

  return (
    <>
      <div className="workspace-tab-chrome">
        <button
          type="button"
          className="workspace-back-conversation"
          aria-label={locale === "zh" ? "返回对话" : "Back to conversation"}
          title={locale === "zh" ? "返回对话" : "Back to conversation"}
          onClick={() =>
            useSessionWorkspaceStore.getState().showDashboard(sessionId)
          }
        >
          <MessageSquare size={14} />
          <span>{locale === "zh" ? "返回对话" : "Back to conversation"}</span>
        </button>
        <div
          className="workspace-tab-rail"
          role="tablist"
          aria-label={t("workspaceTabsLabel")}
        >
          {tabs.map((tab) => (
            <WorkspaceTabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              sessionId={sessionId}
              activeRef={activeRef}
              environment={environment}
              activate={() => activateTab(sessionId, tab.id)}
              close={() => close(tab)}
              closeOthers={() => closeOthers(tab)}
              canCloseOthers={tabs.length > 1}
            />
          ))}
        </div>

        <div className="workspace-tab-actions">
          <button
            type="button"
            className="workspace-chrome-icon"
            aria-label={t("workspaceRefresh")}
            title={t("workspaceRefresh")}
            disabled={loading}
            onClick={() => {
              refreshWorkspace(sessionId);
              void reload();
            }}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            className="workspace-chrome-icon"
            aria-label={
              focused ? t("workspaceExitFullscreen") : t("workspaceFullscreen")
            }
            title={
              focused ? t("workspaceExitFullscreen") : t("workspaceFullscreen")
            }
            onClick={() =>
              setPresentation(sessionId, focused ? "dock" : "focus")
            }
          >
            {focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>
      {pendingClose && (
        <div className="workspace-unsaved-overlay" role="presentation">
          <div
            className="workspace-unsaved-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-unsaved-title"
          >
            <h2 id="workspace-unsaved-title">
              {locale === "zh" ? "文件有未保存的修改" : "Unsaved changes"}
            </h2>
            <p>
              {locale === "zh"
                ? `是否保存对“${pendingClose.title}”的修改？`
                : `Save changes to “${pendingClose.title}” before closing?`}
            </p>
            <div className="workspace-unsaved-actions">
              <button type="button" onClick={cancelClose}>
                {locale === "zh" ? "取消" : "Cancel"}
              </button>
              <button type="button" onClick={discardAndClose}>
                {locale === "zh" ? "不保存" : "Discard"}
              </button>
              <button
                type="button"
                className="workspace-unsaved-save"
                onClick={() => void saveAndClose()}
                disabled={savingClose}
              >
                {savingClose
                  ? locale === "zh"
                    ? "保存中…"
                    : "Saving…"
                  : locale === "zh"
                    ? "保存并关闭"
                    : "Save and close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
