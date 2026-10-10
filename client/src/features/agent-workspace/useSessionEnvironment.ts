import { useWorkbenchPageActive } from "../../app/layouts/CachedWorkbenchPage";
import { useWorkspaceRefresh } from "./workspaceRefresh";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import {
  agentRuntimeApi,
  type SessionEnvironment,
} from "../../adapters/transport/agentRuntime";

// External editors do not publish runtime events. Keep a slow safety net,
// while event bursts share one refresh after the server's 5s cache expires.
const REFRESH_MS = 120_000;
const EVENT_REFRESH_MS = 5_000;
const EVENT_BATCH_MS = 250;
const RESUME_STALE_MS = 30_000;
const cache = new Map<string, { value: SessionEnvironment; checkedAt: number }>();
const pending = new Map<string, Promise<SessionEnvironment>>();

async function fetchEnvironment(id: string): Promise<SessionEnvironment> {
  const existing = pending.get(id);
  if (existing) return existing;
  const request = agentRuntimeApi.getSessionEnvironment(id).then((next) => {
    const previous = cache.get(id)?.value;
    // A server check timestamp is not a change to the displayed workspace.
    const { refreshedAt: _nextTime, ...nextContent } = next;
    const { refreshedAt: _previousTime, ...previousContent } = previous ?? {};
    const value = previous && JSON.stringify(previousContent) === JSON.stringify(nextContent)
      ? previous
      : next;
    cache.delete(id);
    cache.set(id, { value, checkedAt: Date.now() });
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return value;
  }).finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}

const SESSION_FIELDS = ["projectId", "childSessionIds", "status", "historyReset", "historyRevision"];
const CHILD_FIELDS = ["parentSessionId", "title", "prompt", "profileId", "status", "completedAt", "resultSummary"];

type RefreshController = {
  reload: () => Promise<void>;
  invalidate: () => void;
};

/** Shared requests and snapshots; automatic refreshes are quiet and coalesced. */
export function useSessionEnvironment(sessionId: string | null) {
  const active = useWorkbenchPageActive();
  const [snapshot, setSnapshot] = useState<{ id: string; value: SessionEnvironment } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const controller = useRef<RefreshController | null>(null);
  const reload = useCallback(() => controller.current?.reload() ?? Promise.resolve(), []);
  const invalidate = useCallback(() => controller.current?.invalidate(), []);
  useWorkspaceRefresh(sessionId, invalidate);

  useEffect(() => {
    setLoadingId(null);
    if (!sessionId || !active) return;
    const id = sessionId;
    let cancelled = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    let settledAt = cache.get(id)?.checkedAt;
    // Metadata patches contain the entire object. Compare only workspace/role
    // fields, so prompt previews, token accounting and compaction do not read Git.
    const metadataKeys = new Map<string, string>();

    const schedule = () => {
      clearTimeout(timer);
      if (cancelled || document.hidden || inFlight) return;
      const delay = dirty
        ? Math.max(EVENT_BATCH_MS, (settledAt ?? 0) + EVENT_REFRESH_MS - Date.now())
        : Math.max(0, (settledAt ?? Date.now()) + REFRESH_MS - Date.now());
      timer = setTimeout(() => void run(true), delay);
    };

    const run = (silent: boolean): Promise<void> => {
      if (cancelled || document.hidden) return Promise.resolve();
      if (inFlight) return inFlight;
      clearTimeout(timer);
      dirty = false;
      if (!silent || !cache.has(id)) setLoadingId(id);
      inFlight = (async () => {
        try {
          const value = await fetchEnvironment(id);
          if (!cancelled) setSnapshot((previous) =>
            previous?.id === id && previous.value === value ? previous : { id, value },
          );
        } catch {
          // Keep the last usable snapshot and retry at the bounded cadence.
        } finally {
          settledAt = Date.now();
          inFlight = undefined;
          if (!cancelled) {
            setLoadingId(null);
            schedule();
          }
        }
      })();
      return inFlight;
    };

    const markDirty = () => {
      if (cancelled) return;
      const alreadyDirty = dirty;
      dirty = true;
      // Do not reset a pending batch on every event (continuous streams must
      // not starve updates). Events during a request leave one trailing refresh.
      if (!alreadyDirty) schedule();
    };

    const refreshFromRuntimeEvent = (event: MessageEvent, kind: "changed" | "step" | "removed") => {
      let payload: { sessionId?: string; patch?: Record<string, unknown> } | null;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      const changedId = payload.sessionId;
      const child = cache.get(id)?.value.subagents?.find((item) => item.id === changedId);
      if (changedId !== id && !child) return;
      if (kind === "changed" && payload.patch && typeof payload.patch === "object") {
        const patch = payload.patch;
        const fields = child ? CHILD_FIELDS : SESSION_FIELDS;
        let relevant = fields.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
        const metadata = patch.sessionMetadata;
        if (metadata && typeof metadata === "object") {
          const data = metadata as Record<string, unknown>;
          const backend = data.backend as Record<string, unknown> | undefined;
          const projection = child
            ? [data.subagentName, data.roleName, data.roleDescription]
            : [backend?.workDir, backend?.workspaceLocation, backend?.workspaceRoots];
          const key = JSON.stringify(projection);
          if (projection.some((value) => value !== undefined) || metadataKeys.has(changedId!)) {
            relevant ||= metadataKeys.get(changedId!) !== key;
            metadataKeys.set(changedId!, key);
          }
        }
        if (!relevant) return;
      }
      markDirty();
    };

    const current: RefreshController = {
      reload: async () => {
        // A user action may follow a mutation. Never reuse a pre-mutation read.
        if (inFlight) await inFlight;
        await run(false);
      },
      invalidate: markDirty,
    };
    controller.current = current;
    const unsubscribe = subscribe({
      events: {
        session_changed: (event) => refreshFromRuntimeEvent(event, "changed"),
        // Input sources and outputs are also part of this snapshot.
        session_step_completed: (event) => refreshFromRuntimeEvent(event, "step"),
        session_deleted: (event) => refreshFromRuntimeEvent(event, "removed"),
        session_archived: (event) => refreshFromRuntimeEvent(event, "removed"),
      },
      onConnect: () => { if (settledAt !== undefined) markDirty(); },
    });
    const onVisibility = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.hidden) return;
      if (dirty || settledAt === undefined || Date.now() - settledAt >= RESUME_STALE_MS) void run(true);
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void run(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (controller.current === current) controller.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [sessionId, active]);

  const environment = sessionId
    ? snapshot?.id === sessionId ? snapshot.value : (cache.get(sessionId)?.value ?? null)
    : null;
  return { sessionId, environment, loading: sessionId !== null && loadingId === sessionId, reload };
}
