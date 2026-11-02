import { create } from "zustand";
import {
  agentRuntimeApi,
  type AutoResumeItem,
  type AutoResumePhase,
} from "../../../adapters/transport/agentRuntime";

export interface AutoResumeStoreState {
  /** The model endpoint is reachable; queued work runs as soon as it is due. */
  online: boolean;
  loaded: boolean;
  /** Session id → queue entry. Sessions not listed here are not being resumed. */
  items: Record<string, AutoResumeItem>;
  refresh: () => Promise<void>;
  /** Fold one `session_auto_resume` event into the map. */
  applyChange: (change: {
    sessionId: string;
    patch?: Record<string, unknown> | null;
  }) => void;
  /** Stop continuing one session; the user takes over. */
  dismiss: (sessionId: string) => Promise<void>;
  reset: () => void;
}

const EMPTY = { online: true, loaded: false, items: {} as Record<string, AutoResumeItem> };

let refreshing: Promise<void> | null = null;

function phaseOf(value: unknown): AutoResumePhase | null {
  return value === "queued" || value === "retrying" || value === "waiting_network"
    ? value
    : null;
}

/**
 * Sessions the runtime is continuing without the user: work restored after a
 * restart, and work parked because the model endpoint could not be reached.
 *
 * The list is a cache of the runtime queue. It is read once on connect and then
 * kept current by `session_auto_resume` events, so an idle app costs no polling.
 */
export const useAutoResumeStore = create<AutoResumeStoreState>((set, get) => ({
  ...EMPTY,

  refresh: () => {
    refreshing ??= agentRuntimeApi
      .getAutoResumeState()
      .then((snapshot) => {
        const items: Record<string, AutoResumeItem> = {};
        for (const item of snapshot.items) items[item.sessionId] = item;
        set({ online: snapshot.online, items, loaded: true });
      })
      .catch(() => {
        // The runtime may not be up yet; the next connect retries.
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  },

  applyChange: ({ sessionId, patch }) => {
    if (!sessionId) return;
    const online = typeof patch?.online === "boolean" ? patch.online : get().online;
    const phase = phaseOf(patch?.phase);
    const items = { ...get().items };
    if (!phase || patch?.removed === true) {
      if (!(sessionId in items)) {
        if (online !== get().online) set({ online });
        return;
      }
      delete items[sessionId];
      set({ online, items });
      return;
    }
    const previous = items[sessionId];
    items[sessionId] = {
      sessionId,
      projectId: previous?.projectId ?? "",
      title: previous?.title ?? null,
      cause: previous?.cause ?? "restart",
      phase,
      attempts:
        typeof patch?.attempts === "number" ? patch.attempts : (previous?.attempts ?? 0),
      enqueuedAt: previous?.enqueuedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextAttemptAt:
        typeof patch?.nextAttemptAt === "string" ? patch.nextAttemptAt : null,
      lastError: previous?.lastError ?? null,
    };
    set({ online, items });
  },

  dismiss: async (sessionId) => {
    const items = { ...get().items };
    delete items[sessionId];
    set({ items });
    try {
      await agentRuntimeApi.dismissAutoResume(sessionId);
    } catch {
      // Keep the optimistic removal; the next refresh restores the truth.
    }
  },

  reset: () => set({ ...EMPTY, items: {} }),
}));

/** Read the queue entry for one session without re-rendering on other rows. */
export function useSessionAutoResume(sessionId: string): AutoResumeItem | undefined {
  return useAutoResumeStore((state) => state.items[sessionId]);
}
