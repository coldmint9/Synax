import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useWorkbenchPageActive } from "../../app/layouts/CachedWorkbenchPage";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import {
  agentRuntimeApi,
  type SessionEnvironmentInputs,
  type SessionEnvironmentOutputs,
  type SessionEnvironmentRoots,
  type SessionEnvironmentSubagents,
} from "../../adapters/transport/agentRuntime";

/**
 * Session-scoped environment cards.
 *
 * Each card (`roots`, `subagents`, `inputs`, `outputs`) has its own cache,
 * in-flight request, refresh cadence and event relevance, so opening the
 * workspace panel never pages the transcript for a card nobody displays.
 * Git changes are *not* here: they live in `workspaceGitStore.ts` and are
 * shared by every session of a workspace.
 */

const EVENT_BATCH_MS = 250;
const RESUMED_STALE_MS = 30_000;
const CARD_LIMIT = 24;

interface CardEntry<T> {
  value: T;
  checkedAt: number;
}

type RuntimePayload = {
  sessionId?: string;
  projectId?: string;
  patch?: Record<string, unknown>;
};

type RuntimeEventType =
  | "session_changed"
  | "session_created"
  | "session_deleted"
  | "session_archived"
  | "session_step_completed";

interface CardDefinition<T> {
  kind: string;
  load: (sessionId: string) => Promise<T>;
  ttlMs: number;
  slowRefreshMs: number;
  events: RuntimeEventType[];
  /** Which events can actually change this card's payload. */
  matches: (sessionId: string, payload: RuntimePayload, current: T | null) => boolean;
}

interface SessionCard<T> extends CardDefinition<T> {
  entries: Map<string, CardEntry<T>>;
  pending: Map<string, Promise<T>>;
  listeners: Set<() => void>;
}

function readPayload(event: MessageEvent): RuntimePayload | null {
  try {
    const payload = JSON.parse(event.data) as RuntimePayload;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function hasPatchField(payload: RuntimePayload, keys: string[]): boolean {
  const patch = payload.patch;
  if (!patch || typeof patch !== "object") return true;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

function createSessionCard<T>(
  definition: CardDefinition<T>,
): SessionCard<T> {
  return {
    ...definition,
    entries: new Map(),
    pending: new Map(),
    listeners: new Set(),
  };
}

function cardSnapshot<T>(card: SessionCard<T>, sessionId: string | null): T | null {
  if (!sessionId) return null;
  return card.entries.get(sessionId)?.value ?? null;
}

function emitCard<T>(card: SessionCard<T>) {
  for (const listener of card.listeners) listener();
}

function subscribeCard<T>(card: SessionCard<T>, listener: () => void): () => void {
  card.listeners.add(listener);
  return () => {
    card.listeners.delete(listener);
  };
}

function loadCard<T>(
  card: SessionCard<T>,
  sessionId: string | null,
  maxAgeMs = 0,
): Promise<T | null> {
  if (!sessionId) return Promise.resolve(null);
  const cached = card.entries.get(sessionId);
  if (cached && Date.now() - cached.checkedAt < maxAgeMs)
    return Promise.resolve(cached.value);
  const pending = card.pending.get(sessionId);
  if (pending) return pending;
  const request = card
    .load(sessionId)
    .then((value) => {
      if (card.pending.get(sessionId) !== request) return value;
      card.entries.delete(sessionId);
      card.entries.set(sessionId, { value, checkedAt: Date.now() });
      while (card.entries.size > CARD_LIMIT)
        card.entries.delete(card.entries.keys().next().value!);
      emitCard(card);
      return value;
    })
    .finally(() => {
      if (card.pending.get(sessionId) === request) card.pending.delete(sessionId);
    });
  card.pending.set(sessionId, request);
  return request;
}

function invalidateCard<T>(card: SessionCard<T>, sessionId?: string | null): void {
  if (!sessionId) {
    card.entries.clear();
    card.pending.clear();
    emitCard(card);
    return;
  }
  card.entries.delete(sessionId);
  card.pending.delete(sessionId);
  emitCard(card);
}

const rootsCard = createSessionCard<SessionEnvironmentRoots>({
  kind: "roots",
  load: (sessionId) => agentRuntimeApi.getSessionEnvironmentRoots(sessionId),
  // Root metadata only changes with project membership or the session binding.
  ttlMs: 120_000,
  slowRefreshMs: 120_000,
  events: ["session_changed", "session_deleted", "session_archived"],
  matches: (sessionId, payload) =>
    payload.sessionId === sessionId &&
    hasPatchField(payload, ["sessionMetadata", "projectId"]),
});

const subagentsCard = createSessionCard<SessionEnvironmentSubagents>({
  kind: "subagents",
  load: (sessionId) => agentRuntimeApi.getSessionEnvironmentSubagents(sessionId),
  ttlMs: 15_000,
  slowRefreshMs: 30_000,
  events: [
    "session_changed",
    "session_created",
    "session_step_completed",
    "session_deleted",
    "session_archived",
  ],
  matches: (sessionId, payload, current) => {
    if (!payload.sessionId) return true;
    if (payload.sessionId === sessionId) return true;
    // A subagent is its own session: its events move this card too.
    return Boolean(current?.subagents.some((child) => child.id === payload.sessionId));
  },
});

const inputsCard = createSessionCard<SessionEnvironmentInputs>({
  kind: "inputs",
  load: (sessionId) => agentRuntimeApi.getSessionEnvironmentInputs(sessionId),
  ttlMs: 30_000,
  slowRefreshMs: 60_000,
  events: ["session_step_completed", "session_deleted", "session_archived"],
  matches: (sessionId, payload) => payload.sessionId === sessionId,
});

const outputsCard = createSessionCard<SessionEnvironmentOutputs>({
  kind: "outputs",
  load: (sessionId) => agentRuntimeApi.getSessionEnvironmentOutputs(sessionId),
  ttlMs: 30_000,
  slowRefreshMs: 60_000,
  events: ["session_step_completed", "session_deleted", "session_archived"],
  matches: (sessionId, payload) => payload.sessionId === sessionId,
});

const CARDS: Array<SessionCard<unknown>> = [
  rootsCard,
  subagentsCard,
  inputsCard,
  outputsCard,
] as unknown as Array<SessionCard<unknown>>;

/** Drop every session card of one session (or all of them). */
export function invalidateSessionEnvironmentCards(sessionId?: string | null): void {
  for (const card of CARDS) invalidateCard(card, sessionId);
}

export function loadSessionEnvironmentRoots(
  sessionId: string | null,
  maxAgeMs = 0,
): Promise<SessionEnvironmentRoots | null> {
  return loadCard(rootsCard, sessionId, maxAgeMs);
}

export function loadSessionEnvironmentSubagents(
  sessionId: string | null,
  maxAgeMs = 0,
): Promise<SessionEnvironmentSubagents | null> {
  return loadCard(subagentsCard, sessionId, maxAgeMs);
}

export function loadSessionEnvironmentInputs(
  sessionId: string | null,
  maxAgeMs = 0,
): Promise<SessionEnvironmentInputs | null> {
  return loadCard(inputsCard, sessionId, maxAgeMs);
}

export function loadSessionEnvironmentOutputs(
  sessionId: string | null,
  maxAgeMs = 0,
): Promise<SessionEnvironmentOutputs | null> {
  return loadCard(outputsCard, sessionId, maxAgeMs);
}

/**
 * One card, one request stream: a card only reloads for events that can change
 * it, is gated by visibility and the workbench page, and falls back to a slow
 * refresh for changes nobody publishes.
 */
function useSessionCard<T>(
  card: SessionCard<T>,
  sessionId: string | null,
  options?: { enabled?: boolean },
) {
  const pageActive = useWorkbenchPageActive();
  const enabled = (options?.enabled ?? true) && pageActive;
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeCard(card, listener), [card]),
    useCallback(() => cardSnapshot(card, sessionId), [card, sessionId]),
    () => null,
  );
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    invalidateCard(card, sessionId);
    try {
      await loadCard(card, sessionId);
    } catch {
      // Keep the last usable card; the bounded cadence retries.
    }
  }, [card, sessionId]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<unknown> | undefined;

    const run = (): Promise<void> => {
      if (cancelled || document.hidden) return Promise.resolve();
      if (inFlight) return inFlight.then(() => undefined);
      clearTimeout(timer);
      const warm = card.entries.has(sessionId);
      if (!warm) setLoading(true);
      inFlight = loadCard(card, sessionId)
        .catch(() => null)
        .finally(() => {
          inFlight = undefined;
          if (cancelled) return;
          setLoading(false);
          scheduleSlow();
        });
      return inFlight.then(() => undefined);
    };

    const scheduleSlow = () => {
      clearTimeout(timer);
      if (cancelled || document.hidden) return;
      timer = setTimeout(() => void run(), card.slowRefreshMs);
    };

    const markDirty = () => {
      if (cancelled) return;
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => void run(), EVENT_BATCH_MS);
    };

    const handlers: Partial<Record<RuntimeEventType, (event: MessageEvent) => void>> = {};
    for (const type of card.events)
      handlers[type] = (event) => {
        const payload = readPayload(event);
        if (!payload) return;
        if (!card.matches(sessionId, payload, card.entries.get(sessionId)?.value ?? null))
          return;
        markDirty();
      };

    const unsubscribe = subscribe({
      events: handlers,
      onConnect: () => {
        if (card.entries.has(sessionId)) markDirty();
      },
    });
    const onVisibility = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.hidden) return;
      const checked = card.entries.get(sessionId)?.checkedAt;
      if (checked === undefined || Date.now() - checked >= RESUMED_STALE_MS) void run();
      else scheduleSlow();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const cached = card.entries.get(sessionId);
    if (cached && Date.now() - cached.checkedAt < card.ttlMs) scheduleSlow();
    else void run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [card, sessionId, enabled]);

  return { sessionId, value, loading: sessionId !== null && loading, reload };
}

export function useSessionEnvironmentRoots(
  sessionId: string | null,
  options?: { enabled?: boolean },
) {
  return useSessionCard(rootsCard, sessionId, options);
}

export function useSessionEnvironmentSubagents(
  sessionId: string | null,
  options?: { enabled?: boolean },
) {
  return useSessionCard(subagentsCard, sessionId, options);
}

export function useSessionEnvironmentInputs(
  sessionId: string | null,
  options?: { enabled?: boolean },
) {
  return useSessionCard(inputsCard, sessionId, options);
}

export function useSessionEnvironmentOutputs(
  sessionId: string | null,
  options?: { enabled?: boolean },
) {
  return useSessionCard(outputsCard, sessionId, options);
}
