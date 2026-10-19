import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessionList } from "./useSessionList";
import { SessionListHeader } from "./SessionListHeader";
import { SessionTimeGroups } from "./SessionTimeGroups";
import { WorkspaceDirectoryTree } from "./WorkspaceDirectoryTree";
import "./workspaceDirectoryTree.css";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import type { SessionListView } from "./sessionBuckets";
import { sessionsPath, workflowSessionsPath } from "./sessionRoutes";
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
} from "./sessionLastVisit";

interface Props {
  listView?: SessionListView;
  projectId: string;
  onCollapsePanel?: () => void;
  sidebarView?: "sessions" | "workspace";
  onSidebarViewChange?: (view: "sessions" | "workspace") => void;
}

export function SessionListPanel({
  listView = "sessions",
  projectId,
  onCollapsePanel,
  sidebarView = "sessions",
  onSidebarViewChange,
}: Props) {
  const { locale, t } = useLocale();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const list = useSessionList(locale, listView, projectId);
  const { refresh } = list;
  const pendingArchives = useRef(new Set<string>());
  const [archiving, setArchiving] = useState(false);
  useEffect(() => {
    if (!projectId || !list.isProjectReady) return;
    void refresh({ joinPending: true });
  }, [projectId, listView, list.isProjectReady, refresh]);

  const handleArchive = async (id: string) => {
    if (pendingArchives.current.has(id)) return;
    pendingArchives.current.add(id);
    try {
      const archivedIds = await list.deleteSession(id, () => navigate("/settings?section=archive"));
      const last = loadSessionLastVisit(projectId);
      if (last?.kind === "session" && archivedIds.includes(last.sessionId)) {
        clearSessionLastVisit(projectId);
      }
      const selected = searchParams.get("session");
      if (selected && archivedIds.includes(selected)) {
        navigate(listView === "workflow" ? workflowSessionsPath(projectId) : sessionsPath(projectId));
      }
      void list.refresh();
    } catch (err) {
      useNotificationStore.getState().push({ type: "error", message: t("sessionDeleteFailed") });
      console.error("[ArchiveSession]", err);
    } finally {
      pendingArchives.current.delete(id);
    }
  };

  const handleNewSession = () => {
    list.openNewDraft();
  };

  const handleArchiveInactive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      await agentRuntimeApi.clearInactiveSessions(projectId);
      await list.refresh();
    } catch (err) {
      console.error("[ArchiveInactive]", err);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="session-list-panel flex h-full min-h-0 flex-col">
      <div className="session-list-card session-list-card--sessions flex min-h-0 flex-1 flex-col overflow-hidden">
        <SessionListHeader
          listView={listView}
          workflowCount={list.viewCounts.workflow}
          hasMoreSessions={list.hasMore}
          searchQuery={list.searchQuery}
          onSearchChange={list.setSearchQuery}
          onClearInactive={() => void handleArchiveInactive()}
          onNewSession={handleNewSession}
          onOpenWorkflows={() => navigate(workflowSessionsPath(projectId))}
          onBackToSessions={() => navigate(sessionsPath(projectId))}
          onCollapsePanel={onCollapsePanel}
          sidebarView={sidebarView}
          onSidebarViewChange={onSidebarViewChange}
        />
        {sidebarView === "workspace" ? (
          <WorkspaceDirectoryTree projectId={projectId} />
        ) : (
          <div className="session-list-session-area min-h-0">
            <SessionTimeGroups
              key={`${projectId}:${listView}:${list.searchQuery}`}
              groups={list.groups}
              isLoading={list.isRefreshing || !list.isProjectReady}
              error={list.error}
              onRetry={() => void list.refresh()}
              selectedId={list.selectedId}
              isLoadingMore={list.isLoadingMore}
              hasMore={list.hasMore}
              hideGroupHeaders={listView === "sessions" ? false : !list.hasPinned}
              onTogglePin={list.togglePin}
              emptyLabel={list.searchQuery.trim()
                ? locale === "zh" ? "当前工作区没有匹配的会话" : "No matching sessions in this workspace"
                : listView === "workflow" ? t("sessionWorkflowEmpty") : t("sessionListEmpty")}
              onSelect={list.select}
              onToggleGroup={list.toggleGroup}
              onToggleExpand={list.toggleExpand}
              onLoadMore={list.loadMore}
              onDelete={(id) => void handleArchive(id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
