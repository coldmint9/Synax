import { useWikiStore } from "../../state/wikiStore";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessionList } from "./useSessionList";
import { SessionListHeader } from "./SessionListHeader";
import { SessionTimeGroups } from "./SessionTimeGroups";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { useLocale } from "../../../hooks/useLocale";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import type { SessionListView } from "./sessionBuckets";
import { getSessionDisplayTitle } from "./useSessionDisplayTitle";
import { sessionsPath, workflowSessionsPath } from "./sessionRoutes";
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
} from "./sessionLastVisit";

interface Props {
  listView?: SessionListView;
  projectId: string;
  onCollapsePanel?: () => void;
}

export function SessionListPanel({
  listView = "sessions",
  projectId,
  onCollapsePanel,
}: Props) {
  const { locale, t } = useLocale();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const list = useSessionList(locale, listView, projectId);
  const { refresh } = list;
  const hasGeneratedWiki = useWikiStore(
    (s) =>
      s.snapshot?.projectId === projectId &&
      s.documents.some(
        (doc) =>
          doc.projectId === projectId &&
          !doc.isSection &&
          Boolean(doc.contentMd.trim()),
      ),
  );

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  useEffect(() => {
    if (!projectId || !list.isProjectReady) return;
    void refresh({ joinPending: true });
  }, [projectId, listView, list.isProjectReady, refresh]);

  const deleteSession = deleteId
    ? list.groups
        .flatMap((g) => g.sessions)
        .find((n) => n.session.id === deleteId)?.session
    : undefined;
  const deleteTitle = deleteSession
    ? getSessionDisplayTitle(deleteSession, "", locale)
    : "";

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
      <div className="session-list-card session-list-card--sessions min-h-0">
        <SessionListHeader
          listView={listView}
          workflowCount={list.viewCounts.workflow}
          hasMoreSessions={list.hasMore}
          hasGeneratedWiki={hasGeneratedWiki}
          searchQuery={list.searchQuery}
          onSearchChange={list.setSearchQuery}
          onClearInactive={() => void handleArchiveInactive()}
          onNewSession={handleNewSession}
          onOpenWorkflows={() => navigate(workflowSessionsPath(projectId))}
          onBackToSessions={() => navigate(sessionsPath(projectId))}
          onCollapsePanel={onCollapsePanel}
        />
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
            hideGroupHeaders
            emptyLabel={
              list.searchQuery.trim()
                ? locale === "zh"
                  ? "当前工作区没有匹配的会话"
                  : "No matching sessions in this workspace"
                : listView === "workflow"
                  ? t("sessionWorkflowEmpty")
                  : t("sessionListEmpty")
            }
            onSelect={list.select}
            onToggleGroup={list.toggleGroup}
            onToggleExpand={list.toggleExpand}
            onLoadMore={() => {
              void list.loadMore();
            }}
            onDelete={setDeleteId}
          />
        </div>
      </div>
      <SessionDeleteDialog
        isOpen={deleteId !== null}
        sessionTitle={deleteTitle}
        isDeleting={deleting}
        onConfirm={async () => {
          const id = deleteId;
          if (!id) return;
          setDeleting(true);
          try {
            await list.deleteSession(id);
            const last = loadSessionLastVisit(projectId);
            if (last?.kind === "session" && last.sessionId === id) {
              clearSessionLastVisit(projectId);
            }
            if (searchParams.get("session") === id) {
              navigate(
                listView === "workflow"
                  ? workflowSessionsPath(projectId)
                  : sessionsPath(projectId),
              );
            }
            setDeleteId(null);
            void list.refresh();
          } catch (err) {
            console.error("[DeleteSession]", err);
          } finally {
            setDeleting(false);
          }
        }}
        onClose={() => {
          if (!deleting) setDeleteId(null);
        }}
      />

    </div>
  );
}
