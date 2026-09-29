import { useSessionSearch } from "./useSessionSearch";
import { useState, useMemo, useCallback, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import type {
  AgentSession,
  AgentSessionStatus,
} from "../../../lib/api/agentRuntime";
import {
  isAgentWorkspaceSession,
  isWorkflowSession,
  listRootSessions,
  type SessionListView,
} from "./sessionBuckets";
import {
  sessionPath,
  workflowSessionPath,
  isNewSessionPath,
  newSessionPath,
} from "./sessionRoutes";

// ---- Types ----

export interface SessionTreeNode {
  session: AgentSession;
  depth: number;
  children: SessionTreeNode[];
  expanded: boolean;
  isLastChild?: boolean;
  hasNextSibling?: boolean;
  searchSnippet?: string;
  searchQuery?: string;
}

export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionTreeNode[];
  collapsed: boolean;
  count: number;
}

/** Local calendar-day boundary; the list groups on the user's clock, not UTC. */
function startOfLocalDay(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// ---- Hook ----

export function useSessionList(
  locale: "zh" | "en" = "zh",
  listView: SessionListView = "sessions",
  routeProjectId = "",
) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const storeProjectId = useAgentSessionStore((s) => s.projectId);
  const storeSessions = useAgentSessionStore((s) => s.sessions);
  const storeRefresh = useAgentSessionStore((s) => s.refreshSessions);
  const deleteSession = useAgentSessionStore((s) => s.deleteSession);

  const projectSessions = useMemo(() => {
    if (!routeProjectId) return [];
    return storeSessions.filter((s) => s.projectId === routeProjectId);
  }, [routeProjectId, storeSessions]);

  const isProjectReady =
    Boolean(routeProjectId) && storeProjectId === routeProjectId;

  const total = useAgentSessionStore((s) => s.sessionListTotal);
  const totalCount = total ?? projectSessions.length;
  const offset = useAgentSessionStore((s) => s.sessionListOffset);
  const hasMore = total !== null && offset < total;
  const isRefreshing = useAgentSessionStore((s) => s.sessionListLoading);
  const error = useAgentSessionStore((s) => s.sessionListError);
  const storeLoadMore = useAgentSessionStore((s) => s.loadMoreSessions);
  const loadingMore = useRef(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const search = useSessionSearch(routeProjectId, searchQuery);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(
    new Set(),
  );
  const nodeCache = useMemo(
    () => new WeakMap<AgentSession, SessionTreeNode>(),
    [routeProjectId],
  );

  const isDraftOpen =
    listView === "sessions" && isNewSessionPath(location.pathname);
  const selectedIdFromUrl = searchParams.get("session");

  const viewCounts = useMemo(() => {
    const topLevel = projectSessions.filter((s) => !s.parentSessionId);
    let sessionsCount = 0;
    let workflow = 0;
    for (const session of topLevel) {
      if (isWorkflowSession(session)) workflow += 1;
      else if (isAgentWorkspaceSession(session)) sessionsCount += 1;
    }
    return { sessions: sessionsCount, workflow };
  }, [projectSessions]);

  // The memo below buckets sessions on a local calendar-day boundary; keying it
  // on the day string re-splits the list when the app is left open past midnight.
  const dayKey = new Date().toDateString();
  const grouped = useMemo(() => {
    const roots = listRootSessions(projectSessions).filter((s) =>
      listView === "workflow"
        ? isWorkflowSession(s)
        : isAgentWorkspaceSession(s),
    );
    if (search.enabled) {
      const list = search.items.map((item) => item.session);
      const tree = list
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((session) => ({
          session,
          depth: 0,
          children: [],
          expanded: false,
          searchSnippet: search.items.find(
            (item) => item.session.id === session.id,
          )?.snippet,
          searchQuery: search.query,
        }));
      return [{
        key: listView,
        label: listView === "sessions" ? (locale === "zh" ? "会话" : "Sessions") : "Workflows",
        sessions: tree,
        collapsed: false,
        count: tree.length,
      }];
    }

    const sessionById = new Map(projectSessions.map((session) => [session.id, session]));
    const buildTree = (
      session: AgentSession,
      depth: number,
      isLastChild = false,
      hasNextSibling = false,
    ): SessionTreeNode => {
      const childSessions = (session.childSessionIds ?? [])
        .map((id) => sessionById.get(id))
        .filter((child): child is AgentSession => Boolean(child))
        .filter((child) => child.projectId === routeProjectId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const children = childSessions.map((child, index) =>
        buildTree(
          child,
          depth + 1,
          index === childSessions.length - 1,
          index < childSessions.length - 1,
        ),
      );
      return {
        session,
        depth,
        children,
        expanded: !collapsedSessions.has(session.id),
        isLastChild,
        hasNextSibling,
      };
    };

    const tree = roots
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((session, index, all) =>
        buildTree(session, 0, index === all.length - 1, index < all.length - 1),
      );
    const flattenVisible = (nodes: SessionTreeNode[]): SessionTreeNode[] =>
      nodes.flatMap((node) =>
        node.expanded ? [node, ...flattenVisible(node.children)] : [node],
      );
    const visibleTree = flattenVisible(tree);
    const pinned = tree.filter(
      (node) => node.session.sessionMetadata?.pinned === true,
    );
    const hasPinned = pinned.length > 0;
    const regularRoots = hasPinned
      ? tree.filter((node) => node.session.sessionMetadata?.pinned !== true)
      : tree;
    const regular = hasPinned ? flattenVisible(regularRoots) : visibleTree;
    const pinnedVisible = flattenVisible(pinned);
    // Sessions are already sorted newest-first, so the two buckets stay ordered.
    // Search hits bypass bucketing: a result set is a hit list, not a timeline.
    const bucketByDay = listView === "sessions" && !search.enabled;
    const dayStart = startOfLocalDay(Date.now());
    const isToday = (node: SessionTreeNode) =>
      Date.parse(node.session.updatedAt) >= dayStart;
    const today = bucketByDay ? regular.filter(isToday) : [];
    const earlier = bucketByDay
      ? regular.filter((node) => !isToday(node))
      : [];
    const regularGroups: SessionGroup[] = bucketByDay
      ? [
          {
            key: "today",
            label: locale === "zh" ? "今天" : "Today",
            sessions: today,
            collapsed: false,
            count: today.length,
          },
          {
            key: "earlier",
            label: locale === "zh" ? "之前" : "Earlier",
            sessions: earlier,
            collapsed: false,
            count: earlier.length,
          },
        ].filter((group) => group.count > 0)
      : [
          {
            key: listView,
            label: hasPinned
              ? locale === "zh"
                ? "会话"
                : "sessions"
              : listView === "sessions"
                ? locale === "zh"
                  ? "会话"
                  : "Sessions"
                : "Workflows",
            sessions: regular,
            collapsed: false,
            count: regular.length,
          },
        ];
    return [
      ...(hasPinned
        ? [
            {
              key: `pinned:${listView}`,
              label: locale === "zh" ? "置顶" : "Pinned",
              sessions: pinnedVisible,
              collapsed: collapsedGroups.has(`pinned:${listView}`),
              count: pinnedVisible.length,
            },
          ]
        : []),
      ...regularGroups,
    ];
  }, [
    projectSessions,
    search.enabled,
    search.items,
    search.query,
    collapsedGroups,
    collapsedSessions,
    locale,
    listView,
    nodeCache,
    dayKey,
  ]);

  const refresh = useCallback(
    async (options?: { joinPending?: boolean }) => {
      if (!routeProjectId || !isProjectReady) return;
      if (search.enabled) search.refresh();
      await storeRefresh(options);
    },
    [
      isProjectReady,
      routeProjectId,
      storeRefresh,
      search.enabled,
      search.refresh,
    ],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const current = grouped
        .flatMap((group) => group.sessions)
        .find((node) => node.session.id === id)?.session;
      if (!current || current.projectId !== routeProjectId) return;
      const { session: updated } = await agentRuntimeApi.setSessionPinned(
        id,
        current.sessionMetadata?.pinned !== true,
      );
      if (useAgentSessionStore.getState().projectId !== routeProjectId) return;
      useAgentSessionStore.setState((state) => ({
        // Pin changes reorder server pages; restart the cursor without dropping loaded rows.
        sessionListOffset: 0,
        sessions: state.sessions.map((session) =>
          session.id === id
            ? {
                ...session,
                sessionMetadata: {
                  ...session.sessionMetadata,
                  pinned: updated.sessionMetadata?.pinned === true,
                },
              }
            : session,
        ),
      }));
      await refresh();
    },
    [routeProjectId, refresh, grouped],
  );

  const loadMore = useCallback(async () => {
    if (!routeProjectId || !isProjectReady || loadingMore.current || !hasMore)
      return;
    loadingMore.current = true;
    setIsLoadingMore(true);
    try {
      await storeLoadMore();
    } finally {
      loadingMore.current = false;
      setIsLoadingMore(false);
    }
  }, [routeProjectId, isProjectReady, hasMore, storeLoadMore]);

  const toggleGroup = useCallback(
    (key: string) => {
      if (!key.startsWith("pinned:")) return;
      setCollapsedGroups((p) => {
        const n = new Set(p);
        n.has(key) ? n.delete(key) : n.add(key);
        return n;
      });
    },
    [],
  );

  const toggleExpand = useCallback((id: string) => {
    setCollapsedSessions((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select = useCallback(
    (id: string) => {
      if (!routeProjectId) return;
      useAgentSessionStore.getState().markSessionRead(id);
      if (selectedIdFromUrl === id) {
        useAgentSessionStore.getState().openPanel(id, { forceFresh: true });
        return;
      }
      navigate(
        listView === "workflow"
          ? workflowSessionPath(routeProjectId, id)
          : sessionPath(routeProjectId, id),
      );
    },
    [listView, navigate, routeProjectId, selectedIdFromUrl],
  );

  const openNewDraft = useCallback(() => {
    if (!routeProjectId || listView !== "sessions") return;
    navigate(newSessionPath(routeProjectId));
  }, [listView, navigate, routeProjectId]);

  return {
    groups: grouped,
    hasPinned: grouped.some((group) => group.key.startsWith("pinned:")),
    togglePin,
    listView,
    viewCounts,
    totalCount,
    hasMore: search.enabled ? search.hasMore : hasMore,
    isLoadingMore: search.enabled
      ? search.loading && search.items.length > 0
      : isLoadingMore,
    searchQuery,
    setSearchQuery,
    selectedId: isDraftOpen ? null : selectedIdFromUrl,
    select,
    openNewDraft,
    isDraftOpen,
    refresh,
    loadMore: search.enabled ? search.loadMore : loadMore,
    toggleGroup,
    toggleExpand,
    deleteSession,
    isRefreshing: search.enabled ? search.loading : isRefreshing,
    error: search.enabled ? search.error : error,
    isProjectReady,
  };
}

// Backward-compatible alias for SessionTimeGroups
export type TimeGroup = SessionGroup;

/** @deprecated Status filter removed from Sessions page */
export type StatusFilter = AgentSessionStatus | "all";
