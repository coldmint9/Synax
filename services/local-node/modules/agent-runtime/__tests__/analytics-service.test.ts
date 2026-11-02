import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSessionProjection: vi.fn(),
  sessionStatsAuthoritative: vi.fn(),
  sessionPatch: vi.fn(),
  uiSnapshotAuthoritative: vi.fn(),
  readRetiredSessions: vi.fn(),
}));

vi.mock("../sidecar/runtime-facade.js", () => ({
  runtimeFacade: mocks,
}));
vi.mock("../session-projection.js", () => ({
  projectSessionState: (value: unknown) => value,
}));
vi.mock("../analytics-retention.js", () => ({
  readRetiredSessions: mocks.readRetiredSessions,
}));

import {
  invalidateProjectAnalytics,
  projectAnalytics,
  runAnalyticsBackfillPass,
  startAnalyticsBackfill,
  stopAnalyticsBackfill,
} from "../analytics-service.js";
import {
  RUNTIME_ANALYTICS_VERSION,
  measuredContextUsageSnapshot,
} from "../analytics-projection.js";

const now = "2026-10-22T10:00:00.000Z";

type TestSession = {
  id: string;
  projectId: string;
  parentSessionId: null;
  childSessionIds: string[];
  status: "completed";
  title: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  sessionMetadata: Record<string, unknown>;
};

describe("analytics backfill", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readRetiredSessions.mockResolvedValue([]);
    invalidateProjectAnalytics();
  });

  const completeAnalytics = (steps: number) => ({
    version: RUNTIME_ANALYTICS_VERSION,
    updatedAt: now,
    steps,
    completedRuns: steps,
    completedRunSteps: steps,
    toolCalls: steps * 2,
    toolCounts: { read_file: steps * 2 },
    usage: {
      input: steps * 1000,
      output: steps * 200,
      reasoning: 0,
      cacheRead: steps * 400,
      cacheWrite: 0,
      total: steps * 1200,
      requests: steps,
      recorded: steps,
      missing: 0,
    },
    models: {
      "deepseek-v4-flash": {
        steps,
        input: steps * 1000,
        output: steps * 200,
        total: steps * 1200,
      },
    },
    durationMs: steps * 60_000,
    userInputCount: steps,
    lastUserInputId: null,
    lastStepId: `step-${steps}`,
    lastCompletedRunId: `run-${steps}`,
  });

  const retiredEntry = (sessionId: string) => ({
    sessionId,
    projectId: "project-retired",
    title: `Archived ${sessionId}`,
    sessionGroup: "功能需求",
    parentSessionId: null,
    status: "completed",
    createdAt: now,
    completedAt: now,
    updatedAt: now,
    retiredAt: now,
    retiredReason: "deleted" as const,
    analytics: completeAnalytics(1),
    contextUsage: null,
  });

  it("keeps archived sessions in the totals and retains deleted ones from the ledger", async () => {
    const live: TestSession = {
      id: "live-session",
      projectId: "project-retired",
      parentSessionId: null,
      childSessionIds: [],
      status: "completed",
      title: "Live session",
      prompt: "Live prompt",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      sessionMetadata: { runtimeAnalytics: completeAnalytics(2) },
    };
    const archived: TestSession = {
      ...live,
      id: "archived-session",
      title: "Archived session",
      sessionMetadata: {
        runtimeAnalytics: completeAnalytics(1),
        archivedAt: now,
      },
    };
    let projected: TestSession[] = [live, archived];
    mocks.listSessionProjection.mockImplementation(async () =>
      structuredClone(projected),
    );
    mocks.readRetiredSessions.mockResolvedValue([]);

    const before = await projectAnalytics("project-retired");
    expect(before.totals.sessions).toBe(2);
    expect(before.totals.archivedSessions).toBe(1);
    expect(before.totals.tokens.total).toBe(3 * 1200);
    expect(before.totals.toolCalls).toBe(6);
    expect(before.sessions.map((row) => row.id)).toEqual(["live-session"]);

    // The archive batch expires: the record is gone and only the ledger answers.
    projected = [live];
    mocks.readRetiredSessions.mockResolvedValue([
      retiredEntry("archived-session"),
    ]);
    invalidateProjectAnalytics();
    const afterPurge = await projectAnalytics("project-retired");
    expect(afterPurge.totals.tokens).toEqual(before.totals.tokens);
    expect(afterPurge.totals.toolCalls).toBe(before.totals.toolCalls);
    expect(afterPurge.totals.durationMs).toBe(before.totals.durationMs);
    expect(afterPurge.totals.userInputs).toBe(before.totals.userInputs);
    expect(afterPurge.totals.steps).toBe(before.totals.steps);
    expect(afterPurge.totals.sessions).toBe(2);
    expect(afterPurge.totals.archivedSessions).toBe(0);
    expect(afterPurge.totals.deletedSessions).toBe(1);
    expect(afterPurge.groups.reduce((sum, group) => sum + group.sessions, 0)).toBe(2);
  });

  it("counts a session once when the ledger and a live record both know it", async () => {
    const archived: TestSession = {
      id: "archived-session",
      projectId: "project-retired",
      parentSessionId: null,
      childSessionIds: [],
      status: "completed",
      title: "Archived session",
      prompt: "Archived prompt",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      sessionMetadata: {
        runtimeAnalytics: completeAnalytics(1),
        archivedAt: now,
      },
    };
    mocks.listSessionProjection.mockImplementation(async () =>
      structuredClone([archived]),
    );
    mocks.readRetiredSessions.mockResolvedValue([
      retiredEntry("archived-session"),
    ]);

    const result = await projectAnalytics("project-retired");
    expect(result.totals.sessions).toBe(1);
    expect(result.totals.archivedSessions).toBe(1);
    expect(result.totals.deletedSessions).toBe(0);
    expect(result.totals.tokens.total).toBe(1200);
  });

  it.each([true, false])("preserves concurrent metadata with measured context=%s", async (measured) => {
    const previousContext = measuredContextUsageSnapshot(null, 500, "existing-step", 10_000, now)!;
    const session: TestSession = {
      id: `legacy-backfill-session-${measured}`,
      projectId: `project-${measured}`,
      parentSessionId: null,
      childSessionIds: [],
      status: "completed",
      title: "Legacy session",
      prompt: "Legacy prompt",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      sessionMetadata: {
        concurrentControl: { revision: 7 },
        runtimeAnalytics: { version: 1 },
        contextUsage: previousContext,
      },
    };
    const stats = {
      roundCount: 1,
      completedRunCount: 1,
      completedRunSteps: 1,
      toolCallCount: 0,
      toolBreakdown: {},
      modelBreakdown: {},
      usage: { self: { input: 900, output: 100 } },
      coverage: { self: { requests: 1, recorded: 1, missing: 0 } },
      contextComposition: { messages: 900, total: 900 },
      context: {
        requestId: "step-from-backfill",
        inputTokens: measured ? 900 : null,
      },
      contextLimit: 10_000,
      lastStepId: "step-from-backfill",
      lastCompletedRunId: "run-from-backfill",
    };
    mocks.listSessionProjection.mockImplementation(async () => [structuredClone(session)]);
    mocks.sessionStatsAuthoritative.mockResolvedValue(stats);
    // The old implementation reread here. Even a fresh read cannot protect
    // against another writer immediately before the patch is applied.
    mocks.uiSnapshotAuthoritative.mockImplementation(async () => ({ session: structuredClone(session) }));
    mocks.sessionPatch.mockImplementation(
      async (
        _sessionId: string,
        _requestId: string,
        patch: Record<string, unknown>,
      ) => {
        const metadata = patch.sessionMetadata as Record<string, unknown>;
        // Simulate a concurrent update after any snapshot the backfill read.
        session.sessionMetadata.concurrentControl = { revision: 8 };
        session.sessionMetadata.newConcurrentKey = "keep";
        session.sessionMetadata = {
          ...session.sessionMetadata,
          ...metadata,
        };
        return session;
      },
    );

    const result = await projectAnalytics(session.projectId);

    expect(result.pendingBackfill).toBe(0);
    expect(mocks.sessionStatsAuthoritative).toHaveBeenCalledExactlyOnceWith(session.id, null);
    expect(mocks.sessionPatch).toHaveBeenCalledOnce();
    const patch = mocks.sessionPatch.mock.calls[0][2] as {
      sessionMetadata: Record<string, unknown>;
    };
    expect(Object.keys(patch)).toEqual(["sessionMetadata"]);
    expect(Object.keys(patch.sessionMetadata).sort()).toEqual(
      measured ? ["contextUsage", "runtimeAnalytics"] : ["runtimeAnalytics"],
    );
    expect(patch.sessionMetadata.runtimeAnalytics).toMatchObject({
      version: RUNTIME_ANALYTICS_VERSION,
      steps: 1,
      completedRuns: 1,
    });
    if (measured) {
      expect(patch.sessionMetadata.contextUsage).toMatchObject({
        source: "provider",
        total: 900,
        stepId: "step-from-backfill",
      });
    } else {
      expect(patch.sessionMetadata).not.toHaveProperty("contextUsage");
      expect(session.sessionMetadata.contextUsage).toEqual(previousContext);
    }
    expect(result.sessions[0].context?.total).toBe(measured ? 900 : 500);
    expect(session.sessionMetadata.concurrentControl).toEqual({ revision: 8 });
    expect(session.sessionMetadata.newConcurrentKey).toBe("keep");
    expect(mocks.uiSnapshotAuthoritative).not.toHaveBeenCalled();
  });

  it("mirrors legacy sessions without anyone opening the analytics page", async () => {
    const session = (id: string, projectId: string): TestSession => ({
      id,
      projectId,
      parentSessionId: null,
      childSessionIds: [],
      status: "completed",
      title: "Legacy session",
      prompt: "Legacy prompt",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      sessionMetadata: { runtimeAnalytics: { version: 1 } },
    });
    const sessions = [session("legacy-a", "project-a"), session("legacy-b", "project-b")];
    mocks.listSessionProjection.mockImplementation(async () =>
      structuredClone(sessions),
    );
    mocks.sessionStatsAuthoritative.mockResolvedValue({
      roundCount: 1,
      completedRunCount: 1,
      completedRunSteps: 1,
      usage: { self: { input: 10, output: 5 } },
      coverage: { self: { requests: 1, recorded: 1, missing: 0 } },
    });
    mocks.sessionPatch.mockResolvedValue({});

    await expect(runAnalyticsBackfillPass()).resolves.toBe(0);
    expect(mocks.sessionStatsAuthoritative.mock.calls.map((call) => call[0]).sort()).toEqual([
      "legacy-a",
      "legacy-b",
    ]);
    // Already mirrored sessions are not rescanned on the next pass.
    await expect(runAnalyticsBackfillPass()).resolves.toBe(0);
    expect(mocks.sessionStatsAuthoritative).toHaveBeenCalledTimes(2);
  });

  it("shares a slow background pass instead of stacking scans", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.listSessionProjection.mockImplementation(async () => {
        await pending;
        return [];
      });
      startAnalyticsBackfill();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.listSessionProjection).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.listSessionProjection).toHaveBeenCalledTimes(2);
    } finally {
      await stopAnalyticsBackfill();
      vi.useRealTimers();
    }
  });
});
