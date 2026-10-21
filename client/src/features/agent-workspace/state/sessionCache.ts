import type { SessionDetailCacheEntry } from "./agentSessionStore";

/**
 * Last-known-good transcript cache for the session panel.
 *
 * The store keeps a shallow in-memory LRU (a few sessions, minutes of TTL), so
 * every process restart paid for a full `history-window` read plus one
 * `messages/:id/content` request per omitted message. This module persists the
 * already-rendered, already-hydrated entry so the first paint after a restart
 * is local, and the existing `since=<syncCursor>` refresh reconciles it in the
 * background.
 *
 * Invariants:
 * - Only entries carrying a `historyWindow` revision/epoch are written; a
 *   restored cursor is always revalidated by the runtime (`HISTORY_STALE`).
 * - The persisted shape is a render snapshot, never store state: transport
 *   state, streaming buffers and profile collections stay out.
 * - Timeline index arrays are deliberately not persisted. They are rebuilt from
 *   the window by `seedTimelineIndex`, and a half-restored index would disagree
 *   with the transcript it indexes.
 */

const DB_NAME = "synax-session-cache";
const DB_VERSION = 1;
const DETAIL_STORE = "detail";
const META_STORE = "meta";
const RECORD_SCHEMA = 1;
const PERSIST_DEBOUNCE_MS = 1_000;
const PERSIST_MAX_WAIT_MS = 5_000;
/**
 * A live run refreshes every few seconds. Persisting each refresh would clone
 * megabytes onto the main thread for a copy that is only ever used to paint, so
 * an active session reaches disk at most this often; the terminal or switch-away
 * write still lands immediately.
 */
const PERSIST_ACTIVE_INTERVAL_MS = 30_000;
/** One page of messages may legitimately be large; keep only one extra event. */
const EVENTS_RETAINED = 200;

export const PERSISTED_DETAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const PERSISTED_DETAIL_MAX_SESSIONS = 20;
export const PERSISTED_DETAIL_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const PERSISTED_DETAIL_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export type PersistedDetailEntry = Pick<
  SessionDetailCacheEntry,
  | "runs"
  | "steps"
  | "events"
  | "messages"
  | "toolCalls"
  | "permissions"
  | "cachedAt"
  | "lastVisitedAt"
  | "sessionStats"
  | "sessionTodos"
  | "sessionInvocationUsage"
  | "historyWindow"
  | "historyPagesLoaded"
  | "removed"
  | "historyDeleted"
> & {
  /**
   * Runtime status when the snapshot was taken. A copy saved mid-run cannot be
   * trusted for a completed session without one reconciliation; a copy saved
   * after completion is the finished transcript and stays valid until a
   * rewrite (`historyReset`) or another run marks it active again.
   */
  status: "active" | "terminal";
};

type DetailRecord = {
  schemaVersion: number;
  sessionId: string;
  projectId: string | null;
  savedAt: number;
  bytes: number;
  entry: PersistedDetailEntry;
};

type MetaRecord = {
  sessionId: string;
  projectId: string | null;
  savedAt: number;
  bytes: number;
};

/**
 * Conservative retained-size estimate in UTF-16 units, matching the store's
 * memory budget accounting: shared objects may be over-counted, which is the
 * safe direction. Never allocates a JSON copy of the entry.
 */
export function detailEntryBytes(
  value: unknown,
  budget = Number.POSITIVE_INFINITY,
): number {
  return measure(value, budget, new WeakSet<object>());
}

function measure(
  value: unknown,
  budget: number,
  seen: WeakSet<object>,
): number {
  if (typeof value === "string") return value.length * 2 + 16;
  if (!value || typeof value !== "object") return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 32;
  for (const key in value) {
    bytes +=
      key.length * 2 +
      measure((value as Record<string, unknown>)[key], budget - bytes, seen);
    if (bytes > budget) break;
  }
  return bytes;
}

function factory(): IDBFactory | null {
  return typeof indexedDB === "undefined" ? null : indexedDB;
}

let opening: Promise<IDBDatabase | null> | undefined;

function openDatabase(idb: IDBFactory): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DETAIL_STORE))
        db.createObjectStore(DETAIL_STORE, { keyPath: "sessionId" });
      if (!db.objectStoreNames.contains(META_STORE))
        db.createObjectStore(META_STORE, { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "QuotaExceededError"
  );
}

/**
 * Keep a restorable entry: drop the redundant retained indexes, then the oldest
 * transcript rows. A trimmed entry also loses `olderCursor`/`hasEarlier`, so a
 * restore can never hand the reader a cursor it cannot resume.
 */
function fitEntry(
  entry: PersistedDetailEntry,
  limit: number,
): PersistedDetailEntry | null {
  if (detailEntryBytes(entry) <= limit) return entry;
  const slim: PersistedDetailEntry = {
    ...entry,
    events: entry.events.slice(-EVENTS_RETAINED),
  };
  if (detailEntryBytes(slim) <= limit) return slim;
  let messages = slim.messages;
  while (messages.length > 1) {
    const retained = Math.max(1, Math.ceil(messages.length * 0.9));
    messages = messages.slice(messages.length - retained);
    const candidate: PersistedDetailEntry = {
      ...slim,
      messages,
      historyPagesLoaded: false,
      historyWindow: {
        ...slim.historyWindow!,
        olderCursor: undefined,
        hasEarlier: false,
        incremental: false,
        syncCursor: undefined,
      },
    };
    if (detailEntryBytes(candidate) <= limit) return candidate;
  }
  return null;
}

export function toPersistedEntry(
  entry: SessionDetailCacheEntry | undefined,
  status: "active" | "terminal",
  limit = PERSISTED_DETAIL_MAX_ENTRY_BYTES,
): PersistedDetailEntry | null {
  const window = entry?.historyWindow;
  if (!entry?.cachedAt || !window) return null;
  if (!Number.isFinite(window.revision) || !Number.isFinite(window.epoch))
    return null;
  if (
    !Array.isArray(entry.messages) ||
    !Array.isArray(entry.steps) ||
    !Array.isArray(entry.runs)
  )
    return null;
  return fitEntry(
    {
      runs: entry.runs,
      steps: entry.steps,
      events: entry.events,
      messages: entry.messages,
      toolCalls: entry.toolCalls,
      permissions: entry.permissions,
      cachedAt: entry.cachedAt,
      lastVisitedAt: entry.lastVisitedAt,
      sessionStats: entry.sessionStats,
      sessionTodos: entry.sessionTodos,
      sessionInvocationUsage: entry.sessionInvocationUsage,
      historyWindow: window,
      historyPagesLoaded: entry.historyPagesLoaded,
      removed: entry.removed,
      historyDeleted: entry.historyDeleted,
      status,
    },
    limit,
  );
}

async function deleteRecords(
  db: IDBDatabase,
  sessionIds: readonly string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  const transaction = db.transaction([DETAIL_STORE, META_STORE], "readwrite");
  const done = committed(transaction);
  const detail = transaction.objectStore(DETAIL_STORE);
  const meta = transaction.objectStore(META_STORE);
  for (const id of sessionIds) {
    detail.delete(id);
    meta.delete(id);
  }
  await done;
}

/** LRU across sessions by `savedAt`; `keep` is never evicted by its own write. */
async function enforceLimits(db: IDBDatabase, keep: string): Promise<void> {
  const metas = await requestResult(
    db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll(),
  ) as MetaRecord[];
  const ordered = metas
    .filter((meta) => meta && typeof meta.sessionId === "string")
    .sort((a, b) => b.savedAt - a.savedAt);
  const evicted: string[] = [];
  let retained = 0;
  let bytes = 0;
  for (const meta of ordered) {
    const keepThis = meta.sessionId === keep;
    const fits =
      retained < PERSISTED_DETAIL_MAX_SESSIONS &&
      bytes + (meta.bytes ?? 0) <= PERSISTED_DETAIL_MAX_TOTAL_BYTES;
    if (keepThis || fits) {
      retained += 1;
      bytes += meta.bytes ?? 0;
      continue;
    }
    evicted.push(meta.sessionId);
  }
  // The kept session may itself be the newest; never let it survive a budget
  // breach caused by an older large entry that was also retained.
  await deleteRecords(db, evicted);
}

async function writeRecord(
  db: IDBDatabase,
  sessionId: string,
  projectId: string | null,
  entry: PersistedDetailEntry,
): Promise<boolean> {
  const savedAt = Date.now();
  const bytes = detailEntryBytes(entry);
  const record: DetailRecord = {
    schemaVersion: RECORD_SCHEMA,
    sessionId,
    projectId,
    savedAt,
    bytes,
    entry,
  };
  const meta: MetaRecord = { sessionId, projectId, savedAt, bytes };
  const write = async () => {
    const transaction = db.transaction([DETAIL_STORE, META_STORE], "readwrite");
    const done = committed(transaction);
    transaction.objectStore(DETAIL_STORE).put(record);
    transaction.objectStore(META_STORE).put(meta);
    await done;
  };
  try {
    await write();
  } catch (error) {
    if (!isQuotaError(error)) return false;
    await enforceLimits(db, "");
    try {
      await write();
    } catch {
      return false;
    }
  }
  await enforceLimits(db, sessionId);
  return true;
}

let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch(() => undefined);
  return queue;
}

async function persistNow(
  sessionId: string,
  projectId: string | null,
  entry: SessionDetailCacheEntry,
  status: "active" | "terminal",
): Promise<void> {
  const idb = factory();
  if (!idb) return;
  const persisted = toPersistedEntry(entry, status);
  if (!persisted) return;
  const db = await openDatabase(idb);
  if (!db) return;
  if (await writeRecord(db, sessionId, projectId, persisted))
    lastWrittenAt.set(sessionId, Date.now());
}

type PendingWrite = {
  projectId: string | null;
  entry: SessionDetailCacheEntry;
  status: "active" | "terminal";
  timer: ReturnType<typeof setTimeout>;
  scheduledAt: number;
};

const pending = new Map<string, PendingWrite>();
const lastWrittenAt = new Map<string, number>();

export function schedulePersistDetail(
  sessionId: string,
  projectId: string | null,
  entry: SessionDetailCacheEntry | undefined,
  status: "active" | "terminal" = "terminal",
): void {
  if (!entry?.cachedAt) return;
  if (
    status === "active" &&
    Date.now() - (lastWrittenAt.get(sessionId) ?? 0) < PERSIST_ACTIVE_INTERVAL_MS
  )
    return;
  const existing = pending.get(sessionId);
  const scheduledAt = existing?.scheduledAt ?? Date.now();
  if (existing) clearTimeout(existing.timer);
  const flush = () => {
    const current = pending.get(sessionId);
    if (!current) return;
    pending.delete(sessionId);
    void enqueue(() =>
      persistNow(sessionId, current.projectId, current.entry, current.status),
    );
  };
  // A long run keeps refreshing faster than the debounce; cap the wait so the
  // transcript still reaches disk while the session is active.
  if (Date.now() - scheduledAt >= PERSIST_MAX_WAIT_MS) {
    pending.set(sessionId, {
      projectId,
      entry,
      status,
      scheduledAt,
      timer: setTimeout(flush, 0),
    });
    return;
  }
  pending.set(sessionId, {
    projectId,
    entry,
    status,
    scheduledAt,
    timer: setTimeout(flush, PERSIST_DEBOUNCE_MS),
  });
}

export function scheduleDeletePersistedDetail(
  sessionIds: readonly string[],
): void {
  if (sessionIds.length === 0) return;
  for (const id of sessionIds) {
    const existing = pending.get(id);
    if (!existing) continue;
    clearTimeout(existing.timer);
    pending.delete(id);
  }
  void enqueue(async () => {
    const idb = factory();
    if (!idb) return;
    const db = await openDatabase(idb);
    if (!db) return;
    for (const id of sessionIds) lastWrittenAt.delete(id);
    await deleteRecords(db, sessionIds);
  });
}

export async function readPersistedDetail(
  sessionId: string,
  projectId: string | null,
): Promise<SessionDetailCacheEntry | null> {
  const idb = factory();
  if (!idb) return null;
  const db = await openDatabase(idb);
  if (!db) return null;
  let record: DetailRecord | undefined;
  try {
    record = await requestResult(
      db.transaction(DETAIL_STORE, "readonly").objectStore(DETAIL_STORE).get(sessionId),
    ) as DetailRecord | undefined;
  } catch {
    return null;
  }
  if (!record || record.schemaVersion !== RECORD_SCHEMA) return null;
  if (record.sessionId !== sessionId) return null;
  if (projectId !== null && record.projectId !== projectId) return null;
  const age = Date.now() - record.savedAt;
  if (!Number.isFinite(age) || age < 0 || age > PERSISTED_DETAIL_MAX_AGE_MS)
    return null;
  const entry = record.entry;
  const window = entry?.historyWindow;
  if (!window || !Number.isFinite(window.revision) || !Number.isFinite(window.epoch))
    return null;
  if (!Number.isFinite(entry.cachedAt) || !Array.isArray(entry.messages))
    return null;
  return {
    runs: entry.runs ?? [],
    steps: entry.steps ?? [],
    events: entry.events ?? [],
    messages: entry.messages,
    toolCalls: entry.toolCalls ?? [],
    permissions: entry.permissions ?? [],
    // Final for a settled session, and the painted panels need them without a
    // request: a restored transcript that skipped its refresh must not open with
    // an empty usage/todo panel.
    sessionStats: entry.sessionStats ?? null,
    sessionTodos: entry.sessionTodos ?? [],
    sessionInvocationUsage: entry.sessionInvocationUsage ?? null,
    cachedAt: record.savedAt,
    lastVisitedAt: Date.now(),
    historyWindow: window,
    historyPagesLoaded: entry.historyPagesLoaded,
    removed: entry.removed,
    historyDeleted: entry.historyDeleted,
    // How fresh this copy is depends on the status it was captured under.
    restored: entry.status === "active" ? "active" : "terminal",
  };
}

/** Await every debounced write and queued transaction (tests, teardown). */
export async function flushSessionCacheWrites(): Promise<void> {
  for (const [sessionId, write] of [...pending]) {
    clearTimeout(write.timer);
    pending.delete(sessionId);
    void enqueue(() =>
      persistNow(sessionId, write.projectId, write.entry, write.status),
    );
  }
  await queue;
}

/** Test seam: drop the memoized connection so a fresh IndexedDB is observed. */
export function resetSessionCacheConnection(): void {
  opening = undefined;
  queue = Promise.resolve();
  lastWrittenAt.clear();
  for (const write of pending.values()) clearTimeout(write.timer);
  pending.clear();
}
