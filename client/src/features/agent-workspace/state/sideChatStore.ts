import { create } from "zustand";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "./agentSessionStore";
import { useSessionWorkspaceStore } from "./sessionWorkspaceStore";
import { isRuntimeResourceGone } from "../../../shared/lib/runtimeResourceRegistry";

export interface SideChat {
  source: AgentSession;
  requestId: string;
  session?: AgentSession;
  status: "creating" | "ready" | "error" | "closing";
  error?: string;
}

interface SideChatState {
  chats: Record<string, SideChat>;
  start: (source: AgentSession) => void;
  retry: (ownerId: string) => void;
  destroy: (ownerId: string) => Promise<void>;
}

// Requests belong to the temporary window, never to React mount effects.
const creations = new Map<string, Promise<AgentSession>>();
const deletions = new Map<string, Promise<void>>();

function createSession(chat: SideChat): Promise<AgentSession> {
  const pending = creations.get(chat.requestId);
  if (pending) return pending;
  const promise = agentRuntimeApi.createSideChat(chat.source.id, chat.requestId)
    .then(({ session }) => session);
  creations.set(chat.requestId, promise);
  void promise.catch(() => {
    if (creations.get(chat.requestId) === promise) creations.delete(chat.requestId);
  });
  return promise;
}

export function upsertSideChatSession(session: AgentSession) {
  if (isRuntimeResourceGone(session.id)) return;
  useAgentSessionStore.setState((state) => {
    if (state.projectId !== session.projectId) return state;
    const existing = state.sessions.find((row) => row.id === session.id);
    if (existing && existing.updatedAt >= session.updatedAt) return state;
    return { sessions: [...state.sessions.filter((row) => row.id !== session.id), session] };
  });
}

async function prepare(chat: SideChat) {
  const { id } = chat.source;
  try {
    const session = await createSession(chat);
    const current = useSideChatStore.getState().chats[id];
    if (current?.requestId !== chat.requestId || current.status === "closing") return;
    upsertSideChatSession(session);
    useSideChatStore.setState((state) => ({
      chats: { ...state.chats, [id]: { ...current, session, status: "ready", error: undefined } },
    }));
  } catch (reason) {
    useSideChatStore.setState((state) => {
      const current = state.chats[id];
      if (current?.requestId !== chat.requestId || current.status === "closing") return state;
      return { chats: { ...state.chats, [id]: { ...current, status: "error", error: String(reason instanceof Error ? reason.message : reason) } } };
    });
  }
}

export const useSideChatStore = create<SideChatState>((set, get) => ({
  chats: {},
  start: (source) => {
    useSessionWorkspaceStore.getState().closeSubagent(source.id);
    if (get().chats[source.id]) return;
    const chat: SideChat = { source, requestId: crypto.randomUUID(), status: "creating" };
    set((state) => ({ chats: { ...state.chats, [source.id]: chat } }));
    void prepare(chat);
  },
  retry: (ownerId) => {
    const chat = get().chats[ownerId];
    if (!chat || chat.status !== "error") return;
    set((state) => ({ chats: { ...state.chats, [ownerId]: { ...chat, status: "creating", error: undefined } } }));
    void prepare(chat);
  },
  destroy: (ownerId) => {
    const chat = get().chats[ownerId];
    if (!chat) return Promise.resolve();
    const pending = deletions.get(chat.requestId);
    if (pending) return pending;
    set((state) => ({ chats: { ...state.chats, [ownerId]: { ...chat, status: "closing", error: undefined } } }));
    const promise = (async () => {
      try {
        // Recover a lost create reply with the same idempotency key, then
        // delete that exact temporary session rather than leaving an orphan.
        const session = chat.session ?? await createSession(chat);
        upsertSideChatSession(session);
        await useAgentSessionStore.getState().permanentlyDeleteSession(session.id);
        set((state) => {
          if (state.chats[ownerId]?.requestId !== chat.requestId) return state;
          const chats = { ...state.chats };
          delete chats[ownerId];
          return { chats };
        });
        creations.delete(chat.requestId);
      } catch (reason) {
        set((state) => ({ chats: { ...state.chats, [ownerId]: {
          ...chat, status: chat.session ? "ready" : "error",
          error: String(reason instanceof Error ? reason.message : reason),
        } } }));
        throw reason;
      } finally {
        deletions.delete(chat.requestId);
      }
    })();
    deletions.set(chat.requestId, promise);
    return promise;
  },
}));
