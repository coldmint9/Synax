import { create } from "zustand";
import type { SessionEnvironmentInputSource } from "../../../../lib/api/agentRuntime";

export type WorkspaceTabKind = "file" | "diff" | "subagent" | "input";
export type WorkspacePresentation = "dock" | "focus";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  inputSource?: SessionEnvironmentInputSource;
  title: string;
  /** File path for file/diff tabs. */
  path?: string;
  /** Workspace member owning this file; omitted by legacy primary-root links. */
  rootId?: string;
  /** Child session id for subagent tabs. */
  sessionId?: string;
  /** 1-based line a transcript link jumped to; viewers highlight it. */
  line?: number | null;
  /** True while the file viewer has edits that are not saved to disk. */
  dirty?: boolean;
}

export interface WorkspaceSessionState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  presentation: WorkspacePresentation;
  /** Keep the inspected project when a file viewer temporarily replaces the dashboard. */
  selectedRootId?: string;
}

type SessionWorkspaceRecord = Record<string, WorkspaceSessionState>;
type WorkspaceSaveHandler = () => Promise<boolean>;

const saveHandlers = new Map<string, WorkspaceSaveHandler>();
const drafts = new Map<string, string>();

export function registerWorkspaceSaveHandler(
  tabId: string,
  handler: WorkspaceSaveHandler,
): () => void {
  saveHandlers.set(tabId, handler);
  return () => {
    if (saveHandlers.get(tabId) === handler) saveHandlers.delete(tabId);
  };
}

export async function saveWorkspaceTab(tabId: string): Promise<boolean> {
  return (await saveHandlers.get(tabId)?.()) ?? false;
}

export function setWorkspaceDraft(tabId: string, content: string): void {
  drafts.set(tabId, content);
}

export function getWorkspaceDraft(tabId: string): string | undefined {
  return drafts.get(tabId);
}

export function clearWorkspaceDraft(tabId: string): void {
  drafts.delete(tabId);
}

interface SessionWorkspaceStoreState {
  sessions: SessionWorkspaceRecord;
  openTab: (sessionId: string, tab: Omit<WorkspaceTab, "id">) => void;
  activateTab: (sessionId: string, id: string) => void;
  selectRepository: (sessionId: string, rootId: string) => void;
  /** Show the dashboard without discarding the open tabs. */
  showDashboard: (sessionId: string) => void;
  closeTab: (sessionId: string, id: string) => void;
  closeOthers: (sessionId: string, id: string) => void;
  closeAll: (sessionId: string) => void;
  setTabDirty: (sessionId: string, id: string, dirty: boolean) => void;
  setPresentation: (
    sessionId: string,
    presentation: WorkspacePresentation,
  ) => void;
  enterFocus: (sessionId: string) => void;
  exitFocus: (sessionId: string) => void;
  resetSession: (sessionId: string) => void;
  removeSessions: (sessionIds: Iterable<string>) => void;
}

export const EMPTY_SESSION_WORKSPACE: WorkspaceSessionState = Object.freeze({
  tabs: [],
  activeTabId: null,
  presentation: "dock",
});

function tabIdentity(tab: Omit<WorkspaceTab, "id">): string {
  if (tab.kind === "input")
    return `input@${encodeURIComponent(tab.rootId ?? "")}:${tab.inputSource?.toolCallId ?? `${tab.inputSource?.kind}:${tab.inputSource?.label}`}`;
  return tab.kind === "subagent"
    ? `subagent:${tab.sessionId ?? ""}`
    : `${tab.kind}${tab.rootId ? `@${encodeURIComponent(tab.rootId)}` : ""}:${tab.path ?? ""}`;
}

function workspaceState(
  value: WorkspaceSessionState | undefined,
): WorkspaceSessionState {
  return value ?? EMPTY_SESSION_WORKSPACE;
}

function patchSession(
  sessions: SessionWorkspaceRecord,
  sessionId: string,
  patch: (current: WorkspaceSessionState) => WorkspaceSessionState,
): SessionWorkspaceRecord {
  const current = workspaceState(sessions[sessionId]);
  const next = patch(current);
  if (next === current) return sessions;
  return { ...sessions, [sessionId]: next };
}

export const useSessionWorkspaceStore = create<SessionWorkspaceStoreState>(
  (set) => ({
    sessions: {},

    openTab: (sessionId, tab) =>
      set((state) => {
        const id = tabIdentity(tab);
        return {
          sessions: patchSession(state.sessions, sessionId, (current) => {
            const existing = current.tabs.some((item) => item.id === id);
            return {
              ...current,
              // Re-opening the same file must move the line cursor, otherwise a
              // link to a different line of an already open tab would do nothing.
              tabs: existing
                ? current.tabs.map((item) =>
                    item.id === id && tab.line != null
                      ? { ...item, line: tab.line }
                      : item,
                  )
                : [...current.tabs, { ...tab, id }],
              activeTabId: id,
            };
          }),
        };
      }),

    selectRepository: (sessionId, selectedRootId) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          selectedRootId,
        })),
      })),

    activateTab: (sessionId, id) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          activeTabId: id,
        })),
      })),

    showDashboard: (sessionId) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          activeTabId: null,
        })),
      })),

    closeTab: (sessionId, id) => {
      clearWorkspaceDraft(id);
      saveHandlers.delete(id);
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => {
          const tabs = current.tabs.filter((item) => item.id !== id);
          const activeTabId =
            current.activeTabId === id
              ? (tabs[tabs.length - 1]?.id ?? null)
              : current.activeTabId;
          return {
            ...current,
            tabs,
            activeTabId,
            presentation: tabs.length === 0 ? "dock" : current.presentation,
          };
        }),
      }));
    },

    closeOthers: (sessionId, id) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          tabs: current.tabs.filter((item) => item.id === id),
          activeTabId: id,
        })),
      })),

    closeAll: (sessionId) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          tabs: [],
          activeTabId: null,
          presentation: "dock",
        })),
      })),

    setTabDirty: (sessionId, id, dirty) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          tabs: current.tabs.map((tab) =>
            tab.id === id ? { ...tab, dirty: dirty || undefined } : tab,
          ),
        })),
      })),

    setPresentation: (sessionId, presentation) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) =>
          current.presentation === presentation
            ? current
            : { ...current, presentation },
        ),
      })),

    enterFocus: (sessionId) => {
      useSessionWorkspaceStore.getState().setPresentation(sessionId, "focus");
    },

    exitFocus: (sessionId) => {
      useSessionWorkspaceStore.getState().setPresentation(sessionId, "dock");
    },

    resetSession: (sessionId) =>
      set((state) => {
        if (!(sessionId in state.sessions)) return state;
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        return { sessions };
      }),

    removeSessions: (sessionIds) =>
      set((state) => {
        const removed = new Set(sessionIds);
        let changed = false;
        const sessions = { ...state.sessions };
        for (const sessionId of removed) {
          if (sessionId in sessions) {
            delete sessions[sessionId];
            changed = true;
          }
        }
        for (const [ownerId, workspace] of Object.entries(sessions)) {
          const tabs = workspace.tabs.filter(
            (tab) =>
              tab.kind !== "subagent" || !removed.has(tab.sessionId ?? ""),
          );
          if (tabs.length === workspace.tabs.length) continue;
          changed = true;
          const activeTabId = tabs.some(
            (tab) => tab.id === workspace.activeTabId,
          )
            ? workspace.activeTabId
            : null;
          sessions[ownerId] = {
            ...workspace,
            tabs,
            activeTabId,
            presentation: activeTabId ? workspace.presentation : "dock",
          };
        }
        return changed ? { sessions } : state;
      }),
  }),
);

export function useSessionWorkspace(
  sessionId: string | null | undefined,
): WorkspaceSessionState {
  return useSessionWorkspaceStore((state) =>
    sessionId
      ? workspaceState(state.sessions[sessionId])
      : EMPTY_SESSION_WORKSPACE,
  );
}

/** Open a tab, entering focus automatically when the sidecar cannot fit. */
export function openWorkspaceTab(
  sessionId: string,
  tab: Omit<WorkspaceTab, "id">,
): void {
  const store = useSessionWorkspaceStore.getState();
  store.openTab(sessionId, tab);
}

export function showWorkspaceDashboard(sessionId: string): void {
  const store = useSessionWorkspaceStore.getState();
  store.showDashboard(sessionId);
}

export function activateWorkspaceTab(sessionId: string, tabId: string): void {
  const store = useSessionWorkspaceStore.getState();
  store.activateTab(sessionId, tabId);
}

export function openWorkspaceFile(
  sessionId: string,
  path: string,
  line: number | null = null,
  rootId?: string,
  rootName?: string,
): void {
  const name = path.split(/[\\/]/).pop() || path;
  openWorkspaceTab(sessionId, {
    kind: "file",
    title: rootName ? `${rootName} / ${name}` : name,
    path,
    line,
    ...(rootId ? { rootId } : {}),
  });
}

export function openWorkspaceInputSource(
  sessionId: string,
  source: SessionEnvironmentInputSource,
  rootId?: string,
  rootName?: string,
): void {
  if (source.path) {
    openWorkspaceFile(sessionId, source.path, null, rootId, rootName);
    return;
  }
  openWorkspaceTab(sessionId, {
    kind: "input",
    title: rootName ? `${rootName} / ${source.label}` : source.label,
    inputSource: source,
    rootId,
  });
}

export function openWorkspaceDiff(
  sessionId: string,
  path: string,
  rootId?: string,
  rootName?: string,
): void {
  const name = path.split(/[\\/]/).pop() || path;
  openWorkspaceTab(sessionId, {
    kind: "diff",
    title: rootName ? `${rootName} / ${name}` : name,
    path,
    ...(rootId ? { rootId } : {}),
  });
}

export function openWorkspaceSubagent(
  ownerSessionId: string,
  subagentSessionId: string,
  title: string,
): void {
  openWorkspaceTab(ownerSessionId, {
    kind: "subagent",
    title,
    sessionId: subagentSessionId,
  });
}
