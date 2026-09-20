import { refreshWorkspace } from "./workspaceRefresh";
import { useEffect, useRef } from "react";
import {
  Bot,
  MessageSquare,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { FileTypeIcon } from "./FileTypeIcon";
import { useSessionWorkspaceEnvironment } from "./SessionEnvironmentContext";
import {
  useSessionWorkspace,
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

export function WorkspaceTabStrip({ sessionId }: { sessionId: string | null }) {
  const { t, locale } = useLocale();
  const { tabs, activeTabId, presentation } = useSessionWorkspace(sessionId);
  const { loading, reload } = useSessionWorkspaceEnvironment(sessionId);
  const activateTab = useSessionWorkspaceStore((state) => state.activateTab);
  const closeTab = useSessionWorkspaceStore((state) => state.closeTab);
  const setPresentation = useSessionWorkspaceStore(
    (state) => state.setPresentation,
  );
  const activeRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const focused = presentation === "focus";

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  if (!sessionId || !activeTab) return null;

  return (
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
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : undefined}
              className={`workspace-tab-item ${active ? "workspace-tab-item--active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                className="workspace-tab-main"
                aria-selected={active}
                title={tab.path ?? tab.title}
                onClick={() => activateTab(sessionId, tab.id)}
              >
                {tabIcon(tab)}
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={t("workspaceCloseTab", { title: tab.title })}
                title={t("workspaceCloseTab", { title: tab.title })}
                onClick={() => closeTab(sessionId, tab.id)}
              >
                <X size={9} />
              </button>
            </div>
          );
        })}
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
          onClick={() => setPresentation(sessionId, focused ? "dock" : "focus")}
        >
          {focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>
    </div>
  );
}
