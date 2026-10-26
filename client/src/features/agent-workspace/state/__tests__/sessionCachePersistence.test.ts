import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeApi } from "../../../../adapters/transport/agentRuntime";
import { useAgentSessionStore as store } from "../agentSessionStore";
import {
  PERSISTED_DETAIL_MAX_AGE_MS,
  PERSISTED_DETAIL_MAX_SESSIONS,
  flushSessionCacheWrites,
  readPersistedDetail,
  resetSessionCacheConnection,
  scheduleDeletePersistedDetail,
  schedulePersistDetail,
  toPersistedEntry,
} from "../sessionCache";

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    historyWindow: vi.fn(),
    historyTimeline: vi.fn(),
    historyIndexPage: vi.fn(),
    getSession: vi.fn(),
    getSessionSummary: vi.fn(),
    getSessionStats: vi.fn(async () => null),
    getSessionTodos: vi.fn(async () => ({ items: [] })),
    getSessionInvocationUsage: vi.fn(async () => null),
  },
}));

/** Minimal in-memory IndexedDB: only the surface `sessionCache` uses. */
type FakeRequest = {
  result?: unknown;
  error?: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

function ok(result?: unknown): FakeRequest {
  const request: FakeRequest = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

class FakeStore {
  readonly data = new Map<string, Record<string, unknown>>();
  constructor(readonly keyPath: string) {}
  put(value: Record<string, unknown>): FakeRequest {
    this.data.set(String(value[this.keyPath]), value);
    return ok();
  }
  get(key: string): FakeRequest {
    return ok(this.data.get(key));
  }
  delete(key: string): FakeRequest {
    this.data.delete(key);
    return ok();
  }
  getAll(): FakeRequest {
    return ok([...this.data.values()]);
  }
  clear(): FakeRequest {
    this.data.clear();
    return ok();
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  constructor(private readonly stores: Map<string, FakeStore>) {}
  objectStore(name: string): FakeStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Unknown store ${name}`);
    return store;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeStore>();
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  createObjectStore(name: string, options: { keyPath: string }): FakeStore {
    const store = new FakeStore(options.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(names: string | string[]): FakeTransaction {
    const stores = new Map<string, FakeStore>();
    for (const name of Array.isArray(names) ? names : [names]) {
      const store = this.stores.get(name);
      if (!store) throw new Error(`Unknown store ${name}`);
      stores.set(name, store);
    }
    const transaction = new FakeTransaction(stores);
    // Handlers are attached synchronously after the transaction is created.
    setTimeout(() => transaction.oncomplete?.(), 0);
    return transaction;
  }
}

let databases = new Map<string, FakeDatabase>();

function installFakeIndexedDb(): void {
  databases = new Map();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: {
      open(name: string) {
        const request: Record<string, unknown> & {
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onupgradeneeded: (() => void) | null;
          result?: unknown;
        } = { onsuccess: null, onerror: null, onupgradeneeded: null };
        const database = databases.get(name) ?? new FakeDatabase();
        databases.set(name, database);
        queueMicrotask(() => {
          request.result = database;
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
  });
}

function records(storeName: "detail" | "meta"): Map<string, Record<string, unknown>> {
  const database = databases.get("synax-session-cache");
  expect(database, "cache database").toBeDefined();
  return database!.stores.get(storeName)!.data;
}

type Entry = Parameters<typeof schedulePersistDetail>[2];

function entry(overrides: Record<string, unknown> = {}): Entry {
  return {
    runs: [],
    steps: [],
    events: [],
    messages: [
      {
        id: "m1",
        sessionId: "session",
        runId: null,
        stepId: null,
        role: "user",
        content: "hello",
        metadata: {},
        createdAt: "t1",
      },
    ],
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    cachedAt: Date.now(),
    historyWindow: {
      revision: 4,
      epoch: 1,
      syncCursor: "sync-4",
      olderCursor: "older-4",
      hasEarlier: true,
      latest: true,
      detailsTruncated: false,
    },
    ...overrides,
  } as unknown as Entry;
}

beforeEach(() => {
  installFakeIndexedDb();
  resetSessionCacheConnection();
});

afterEach(async () => {
  await flushSessionCacheWrites();
  vi.clearAllMocks();
  store.setState(store.getInitialState());
});

describe("persisted transcript cache", () => {
  it("round-trips a rendered entry and revalidates it against the project", async () => {
    schedulePersistDetail("session", "p1", entry());
    await flushSessionCacheWrites();

    const restored = await readPersistedDetail("session", "p1");
    expect(restored?.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(restored?.historyWindow?.syncCursor).toBe("sync-4");
    expect(restored?.sessionStats).toBeNull();

    expect(await readPersistedDetail("session", "p2")).toBeNull();
  });

  it("drops entries older than the restore window", async () => {
    schedulePersistDetail("session", "p1", entry());
    await flushSessionCacheWrites();

    records("detail").get("session")!.savedAt =
      Date.now() - PERSISTED_DETAIL_MAX_AGE_MS - 1;
    expect(await readPersistedDetail("session", "p1")).toBeNull();
  });

  it("keeps the complete minimum tail and resume cursor under a soft byte budget", () => {
    const huge = entry({
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `m${index}`,
        sessionId: "session",
        role: "assistant",
        content: "x".repeat(400),
        createdAt: `t${index}`,
      })),
    });
    const persisted = toPersistedEntry(huge, "terminal", 16 * 1024);
    expect(persisted).not.toBeNull();
    expect(persisted!.messages.length).toBe(40);
    expect(persisted!.messages.at(-1)).toMatchObject({ id: "m39" });
    expect(persisted!.historyWindow?.olderCursor).toBe("older-4");
    expect(persisted!.historyWindow?.hasEarlier).toBe(true);
  });

  it("evicts the oldest sessions beyond the record limit", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let index = 0; index <= PERSISTED_DETAIL_MAX_SESSIONS; index++) {
      clock.mockReturnValue(now + index);
      schedulePersistDetail(`session-${index}`, "p1", entry());
      await flushSessionCacheWrites();
    }
    clock.mockRestore();
    await flushSessionCacheWrites();

    const metas = [...records("meta").keys()];
    expect(metas).toHaveLength(PERSISTED_DETAIL_MAX_SESSIONS);
    expect(metas).not.toContain("session-0");
  });

  it("deletes a removed session's record", async () => {
    schedulePersistDetail("session", "p1", entry());
    await flushSessionCacheWrites();
    scheduleDeletePersistedDetail(["session"]);
    await flushSessionCacheWrites();
    expect(await readPersistedDetail("session", "p1")).toBeNull();
  });
});

function session(status: string) {
  return {
    id: "session",
    projectId: "p1",
    status,
    childSessionIds: [],
    activeRunId: null,
    sessionMetadata: { historyStorage: { version: 1 } },
  } as never;
}

describe("store restore", () => {
  it("reopens a completed transcript from disk without re-reading history", async () => {
    schedulePersistDetail("session", "p1", entry(), "terminal");
    await flushSessionCacheWrites();

    store.setState({
      ...store.getInitialState(),
      projectId: "p1",
      selectedSessionId: "session",
      sessions: [session("completed")],
    });

    await store.getState().paintPersistedDetail("session");
    expect(store.getState().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(store.getState().sessionDetailCache.session?.restored).toBe("terminal");

    store.getState().openPanel("session");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agentRuntimeApi.historyWindow).not.toHaveBeenCalled();
  });

  it("restores the persisted sync cursor before the first history request after restart", async () => {
    schedulePersistDetail("session", "p1", entry(), "active");
    await flushSessionCacheWrites();

    store.setState({
      ...store.getInitialState(),
      projectId: "p1",
      selectedSessionId: "session",
      sessions: [session("completed")],
    });

    vi.mocked(agentRuntimeApi.historyWindow).mockResolvedValue({
      messages: [],
      runs: [],
      steps: [],
      toolCalls: [],
      events: [],
      permissions: [],
      historyWindow: {
        revision: 5,
        epoch: 1,
        syncCursor: "sync-5",
        hasEarlier: false,
        latest: true,
        detailsTruncated: false,
        incremental: true,
      },
    } as never);

    store.getState().openPanel("session");
    await vi.waitFor(() =>
      expect(agentRuntimeApi.historyWindow).toHaveBeenCalledWith(
        "session",
        undefined,
        "sync-4",
      ),
    );
    expect(agentRuntimeApi.historyWindow).toHaveBeenCalledTimes(1);
  });

  it("keeps derived profile queries out of transcript loading until explicitly requested", async () => {
    store.setState({
      ...store.getInitialState(),
      projectId: "p1",
      selectedSessionId: "session",
      sessions: [
        {
          id: "session",
          projectId: "p1",
          status: "completed",
          childSessionIds: [],
          activeRunId: null,
          sessionMetadata: { historyStorage: { version: 1 } },
        },
      ] as never,
    });
    vi.mocked(agentRuntimeApi.historyWindow).mockResolvedValue({
      messages: [],
      runs: [],
      steps: [],
      toolCalls: [],
      events: [],
      permissions: [],
      historyWindow: {
        revision: 6,
        epoch: 1,
        hasEarlier: false,
        latest: true,
        detailsTruncated: false,
      },
    } as never);

    await store.getState().refreshDetail({ forceFresh: true });
    expect(agentRuntimeApi.getSessionStats).not.toHaveBeenCalled();

    await store.getState().refreshDetail();
    expect(agentRuntimeApi.getSessionStats).not.toHaveBeenCalled();
    await store.getState().fetchSessionStats();
    expect(agentRuntimeApi.getSessionStats).toHaveBeenCalledTimes(1);
  });
});
