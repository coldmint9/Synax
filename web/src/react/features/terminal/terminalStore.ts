import { create } from "zustand";
import { terminalApi, type TerminalSession } from "../../../lib/api/terminal";
import type { SessionBackgroundProcess } from "../../../lib/api/agentRuntime";
export interface LegacyTerminal {
  sessionId: string;
  projectId: string;
  process: SessionBackgroundProcess;
  cwd: string;
}
export type TerminalTab =
  | { id: string; terminal: TerminalSession; legacy?: never }
  | { id: string; legacy: LegacyTerminal; terminal?: never };
interface TerminalState {
  open: boolean;
  maximized: boolean;
  height: number;
  tabs: TerminalTab[];
  activeId: string | null;
  pending: number;
  error: string | null;
  show: () => void;
  toggle: () => void;
  hide: () => void;
  maximize: () => void;
  setHeight: (height: number) => void;
  activate: (id: string) => void;
  closeTab: (id: string) => void;
  update: (item: TerminalSession) => void;
  openTerminal: (projectId: string, id: string) => Promise<void>;
  openLegacy: (legacy: LegacyTerminal) => void;
  create: (
    projectId: string,
    rootId?: string,
    sessionId?: string,
  ) => Promise<void>;
  accept: (terminal: TerminalSession, replaceId?: string) => void;
  clearError: () => void;
}
const initialHeight = () => {
  try {
    return Math.min(
      600,
      Math.max(
        180,
        Number(localStorage.getItem("synax:terminal-height")) || 300,
      ),
    );
  } catch {
    return 300;
  }
};
let activation = 0;
const terminalRequested = () => document.dispatchEvent(new CustomEvent("terminal:open"));
export const terminalChanged = () =>
  document.dispatchEvent(new CustomEvent("terminal:changed"));
export const useTerminalStore = create<TerminalState>((set, get) => ({
  open: false,
  maximized: false,
  height: initialHeight(),
  tabs: [],
  activeId: null,
  pending: 0,
  error: null,
  show: () => { terminalRequested(); set({ open: true }); },
  toggle: () => { if (!get().open) terminalRequested(); set((state) => ({ open: !state.open })); },
  hide: () => set({ open: false }),
  maximize: () => set((state) => ({ maximized: !state.maximized })),
  setHeight: (height) => {
    const next = Math.max(160, Math.min(800, height));
    set({ height: next, maximized: false });
    try {
      localStorage.setItem("synax:terminal-height", String(next));
    } catch {}
  },
  activate: (id) => {
    terminalRequested();
    activation++;
    set({ activeId: id, open: true });
  },
  closeTab: (id) => {
    activation++;
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      return {
        tabs,
        activeId:
          state.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeId,
      };
    });
  },
  update: (terminal) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === terminal.id ? { id: terminal.id, terminal } : tab,
      ),
    })),
  clearError: () => set({ error: null }),
  accept: (terminal, replaceId) => {
    terminalRequested();
    set((state) => ({
      open: true,
      activeId: terminal.id,
      tabs: [
        ...state.tabs.filter(
          (tab) => tab.id !== terminal.id && tab.id !== replaceId,
        ),
        { id: terminal.id, terminal },
      ],
    }));
    terminalChanged();
  },
  openTerminal: async (projectId, id) => {
    terminalRequested();
    const existing = get().tabs.find(tab => tab.id === id && tab.terminal?.projectId === projectId);
    if (existing) { activation++; set({ open: true, activeId: id }); return; }
    const version = ++activation;
    set((state) => ({ open: true, pending: state.pending + 1, error: null }));
    try {
      const item = await terminalApi.get(projectId, id);
      if (version === activation) get().accept(item);
      else
        set((state) => ({
          tabs: state.tabs.some((tab) => tab.id === item.id)
            ? state.tabs
            : [...state.tabs, { id: item.id, terminal: item }],
        }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ pending: state.pending - 1 }));
    }
  },
  openLegacy: (legacy) => {
    terminalRequested();
    activation++;
    const id = `legacy:${legacy.process.id}`;
    set((state) => ({
      open: true,
      activeId: id,
      tabs: state.tabs.some((tab) => tab.id === id)
        ? state.tabs
        : [...state.tabs, { id, legacy }],
    }));
  },
  create: async (projectId, rootId, sessionId) => {
    if (get().pending > 0) return;
    terminalRequested();
    const version = ++activation;
    set((state) => ({ open: true, pending: state.pending + 1, error: null }));
    try {
      const item = await terminalApi.create(projectId, {
        rootId,
        sessionId,
        requestId: crypto.randomUUID(),
      });
      if (version === activation) get().accept(item);
      else {
        set((state) => ({
          tabs: [...state.tabs, { id: item.id, terminal: item }],
        }));
        terminalChanged();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => ({ pending: state.pending - 1 }));
    }
  },
}));
