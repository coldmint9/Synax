import { create } from "zustand";
import type { SessionEnvironmentInputSource } from "../../../adapters/transport/agentRuntime";

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
  /** Child conversation shown beside the parent transcript. */
  subagent?: { sessionId: string; title: string; fullscreen?: boolean };
  /** Keep the inspected project when a file viewer temporarily replaces the dashboard. */
  selectedRootId?: string;
}

type SessionWorkspaceRecord = Record<string, WorkspaceSessionState>;
type WorkspaceSaveHandler = () => Promise<boolean>;

interface WorkspaceTabResource {
  draft?: string;
  save?: WorkspaceSaveHandler;
  active: boolean;
}
export interface WorkspaceDraftLease {
  readonly state: WorkspaceTabResource;
}
const resources = new Map<string, Map<string, WorkspaceTabResource>>();

function resource(sessionId: string, tabId: string): WorkspaceTabResource {
  let tabs = resources.get(sessionId);
  if (!tabs) {
    tabs = new Map();
    resources.set(sessionId, tabs);
  }
  let state = tabs.get(tabId);
  if (!state) {
    state = { active: true };
    tabs.set(tabId, state);
  }
  return state;
}
export function acquireWorkspaceDraftLease(
  sessionId: string,
  tabId: string,
): WorkspaceDraftLease {
  return { state: resource(sessionId, tabId) };
}
function currentResource(
  sessionId: string,
  tabId: string,
  lease?: WorkspaceDraftLease,
) {
  const current = resources.get(sessionId)?.get(tabId);
  if (lease && (!lease.state.active || lease.state !== current))
    return undefined;
  return current;
}
function retireWorkspaceTab(sessionId: string, tabId: string) {
  const tabs = resources.get(sessionId),
    state = tabs?.get(tabId);
  if (state) {
    state.active = false;
    delete state.draft;
    delete state.save;
  }
  tabs?.delete(tabId);
  if (!tabs?.size) resources.delete(sessionId);
}
function retireWorkspaceSession(sessionId: string, keepId?: string) {
  const tabs = resources.get(sessionId);
  if (!tabs) return;
  for (const id of [...tabs.keys()])
    if (id !== keepId) retireWorkspaceTab(sessionId, id);
}
export function registerWorkspaceSaveHandler(
  sessionId: string,
  tabId: string,
  handler: WorkspaceSaveHandler,
  lease?: WorkspaceDraftLease,
): () => void {
  const state = lease
    ? currentResource(sessionId, tabId, lease)
    : resource(sessionId, tabId);
  if (!state) return () => {};
  state.save = handler;
  return () => {
    if (state.save === handler) delete state.save;
  };
}
export async function saveWorkspaceTab(
  sessionId: string,
  tabId: string,
): Promise<boolean> {
  return (await currentResource(sessionId, tabId)?.save?.()) ?? false;
}
export function setWorkspaceDraft(
  sessionId: string,
  tabId: string,
  content: string,
  lease?: WorkspaceDraftLease,
): void {
  const state = lease
    ? currentResource(sessionId, tabId, lease)
    : resource(sessionId, tabId);
  if (state) state.draft = content;
}
export function getWorkspaceDraft(
  sessionId: string,
  tabId: string,
  lease?: WorkspaceDraftLease,
): string | undefined {
  return currentResource(sessionId, tabId, lease)?.draft;
}
export function clearWorkspaceDraft(sessionId: string, tabId: string): void {
  const state = currentResource(sessionId, tabId);
  if (state) delete state.draft;
}
export function isWorkspaceDraftLeaseActive(
  sessionId: string,
  tabId: string,
  lease: WorkspaceDraftLease,
): boolean {
  return !!currentResource(sessionId, tabId, lease);
}
export function workspaceResourceCounts() {
  let tabs = 0,
    drafts = 0,
    handlers = 0;
  for (const session of resources.values())
    for (const state of session.values()) {
      tabs++;
      if (state.draft !== undefined) drafts++;
      if (state.save) handlers++;
    }
  return { sessions: resources.size, tabs, drafts, handlers };
}

interface SessionWorkspaceStoreState {
  sessions: SessionWorkspaceRecord;
  openSubagent: (
    sessionId: string,
    childSessionId: string,
    title: string,
  ) => void;
  closeSubagent: (sessionId: string) => void;
  setSubagentFullscreen: (sessionId: string, fullscreen: boolean) => void;
  openTab: (sessionId: string, tab: Omit<WorkspaceTab, "id">) => void;
  activateTab: (sessionId: string, id: string) => void;
  selectRepository: (sessionId: string, rootId: string) => void;
  /** Show the dashboard without discarding the open tabs. */
  showDashboard: (sessionId: string) => void;
  closeTab: (sessionId: string, id: string) => void;
  closeOthers: (sessionId: string, id: string) => void;
  renameFileTabs: (
    sessionId: string,
    rootId: string | undefined,
    oldPath: string,
    newPath: string,
  ) => void;
  closeFileTabs: (
    sessionId: string,
    rootId: string | undefined,
    path: string,
  ) => void;
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
  (set, get) => ({
    sessions: {},

    openSubagent: (sessionId, childSessionId, title) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          subagent: { sessionId: childSessionId, title },
          activeTabId: null,
          presentation: "dock",
        })),
      })),

    closeSubagent: (sessionId) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          subagent: undefined,
        })),
      })),

    setSubagentFullscreen: (sessionId, fullscreen) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) =>
          current.subagent
            ? { ...current, subagent: { ...current.subagent, fullscreen } }
            : current,
        ),
      })),

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
      retireWorkspaceTab(sessionId, id);
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

    renameFileTabs: (sessionId, rootId, oldPath, newPath) =>
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => {
          const tabs = current.tabs.map((tab) => {
            if (
              (tab.kind !== "file" && tab.kind !== "diff") ||
              tab.rootId !== rootId ||
              tab.path !== oldPath
            )
              return tab;
            const title = tab.title.replace(
              oldPath.split(/[\\/]/).pop() ?? oldPath,
              newPath.split(/[\\/]/).pop() ?? newPath,
            );
            const next = { ...tab, path: newPath, title };
            const id = tabIdentity(next);
            const draft = getWorkspaceDraft(sessionId, tab.id);
            retireWorkspaceTab(sessionId, tab.id);
            if (draft !== undefined) setWorkspaceDraft(sessionId, id, draft);
            return { ...next, id };
          });
          const activeIndex = current.tabs.findIndex(
            (tab) => tab.id === current.activeTabId,
          );
          return {
            ...current,
            tabs,
            activeTabId:
              activeIndex < 0 ? current.activeTabId : tabs[activeIndex].id,
          };
        }),
      })),

    closeFileTabs: (sessionId, rootId, path) => {
      const tabs =
        get().sessions[sessionId]?.tabs.filter(
          (tab) =>
            (tab.kind === "file" || tab.kind === "diff") &&
            tab.rootId === rootId &&
            tab.path === path,
        ) ?? [];
      for (const tab of tabs) get().closeTab(sessionId, tab.id);
    },

    closeOthers: (sessionId, id) => {
      retireWorkspaceSession(sessionId, id);
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          tabs: current.tabs.filter((item) => item.id === id),
          activeTabId: id,
        })),
      }));
    },

    closeAll: (sessionId) => {
      retireWorkspaceSession(sessionId);
      set((state) => ({
        sessions: patchSession(state.sessions, sessionId, (current) => ({
          ...current,
          tabs: [],
          activeTabId: null,
          presentation: "dock",
        })),
      }));
    },

    setTabDirty: (sessionId, id, dirty) =>
      set((state) => {
        const current = state.sessions[sessionId];
        if (!current) return state;
        let changed = false;
        const tabs = current.tabs.map((tab) => {
          if (tab.id !== id || !!tab.dirty === dirty) return tab;
          changed = true;
          return { ...tab, dirty: dirty || undefined };
        });
        return changed
          ? {
              sessions: {
                ...state.sessions,
                [sessionId]: { ...current, tabs },
              },
            }
          : state;
      }),

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

    resetSession: (sessionId) => {
      retireWorkspaceSession(sessionId);
      set((state) => {
        if (!(sessionId in state.sessions)) return state;
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        return { sessions };
      });
    },

    removeSessions: (sessionIds) =>
      set((state) => {
        const removed = new Set(sessionIds);
        let changed = false;
        const sessions = { ...state.sessions };
        for (const sessionId of removed) {
          retireWorkspaceSession(sessionId);
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
          const subagentRemoved = Boolean(
            workspace.subagent && removed.has(workspace.subagent.sessionId),
          );
          if (tabs.length === workspace.tabs.length && !subagentRemoved)
            continue;
          changed = true;
          const activeTabId = tabs.some(
            (tab) => tab.id === workspace.activeTabId,
          )
            ? workspace.activeTabId
            : null;
          sessions[ownerId] = {
            ...workspace,
            subagent: subagentRemoved ? undefined : workspace.subagent,
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
  _rootName?: string,
): void {
  const name = path.split(/[\\/]/).pop() || path;
  openWorkspaceTab(sessionId, {
    kind: "file",
    title: name,
    path,
    line,
    ...(rootId ? { rootId } : {}),
  });
}

export function openWorkspaceInputSource(
  sessionId: string,
  source: SessionEnvironmentInputSource,
  rootId?: string,
  _rootName?: string,
): void {
  if (source.path) {
    openWorkspaceFile(sessionId, source.path, null, rootId, _rootName);
    return;
  }
  openWorkspaceTab(sessionId, {
    kind: "input",
    title: source.label,
    inputSource: source,
    rootId,
  });
}

export function openWorkspaceDiff(
  sessionId: string,
  path: string,
  rootId?: string,
  _rootName?: string,
): void {
  const name = path.split(/[\\/]/).pop() || path;
  openWorkspaceTab(sessionId, {
    kind: "diff",
    title: name,
    path,
    ...(rootId ? { rootId } : {}),
  });
}

export function openWorkspaceSubagent(
  ownerSessionId: string,
  subagentSessionId: string,
  title: string,
): void {
  useSessionWorkspaceStore
    .getState()
    .openSubagent(ownerSessionId, subagentSessionId, title);
}
