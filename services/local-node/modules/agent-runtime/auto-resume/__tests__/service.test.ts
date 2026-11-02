import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../contracts.js";
import { AutoResumeJournal } from "../journal.js";
import { SessionAutoResumeService } from "../service.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    projectId: "project-1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status: "interrupted",
    title: id,
    prompt: id,
    contextSnapshotId: null,
    thinkingMode: "standard",
    permissionRules: [],
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T11:55:00.000Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "auto-resume-service-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface HarnessOptions {
  online?: boolean;
  resume?: (sessionId: string) => Promise<void>;
  maxAttempts?: number;
}

function harness(options: HarnessOptions = {}) {
  const sessions = new Map<string, AgentSession>();
  let online = options.online ?? true;
  let now = NOW;
  const resume = vi.fn(options.resume ?? (async () => {}));
  const failures: string[] = [];
  const journal = new AutoResumeJournal(path.join(directory, "runtime", "queue.json"));
  const service = new SessionAutoResumeService({
    journal,
    sessions: {
      list: () => [...sessions.values()],
      get: (sessionId) => sessions.get(sessionId),
    },
    resume,
    isOnline: () => online,
    startDelayMs: 0,
    // Manual ticks only: the queue pass itself must be what a test observes.
    tickIntervalMs: 60_000,
    maxAttempts: options.maxAttempts,
    now: () => now,
    noteNetworkFailure: () => failures.push("network"),
  });
  return {
    service,
    journal,
    sessions,
    resume,
    failures,
    setOnline: (value: boolean) => {
      online = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    start: async () => {
      service.start();
      // Let the boot timer fire and its scan finish.
      await vi.waitFor(() => expect(service.running).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

describe("SessionAutoResumeService", () => {
  it("restores sessions a previous host left unfinished", async () => {
    const context = harness();
    context.sessions.set("session-running", session("session-running", { status: "running" }));
    context.sessions.set("session-done", session("session-done", { status: "completed" }));
    context.sessions.set("session-paused", session("session-paused", { status: "paused" }));

    await context.start();
    await context.service.tick();

    expect(context.resume.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
      "session-paused",
      "session-running",
    ]);
    expect(context.journal.size()).toBe(0);
  });

  it("holds work while offline and continues as soon as the network is back", async () => {
    const context = harness({ online: false });
    context.sessions.set("session-1", session("session-1", { status: "interrupted" }));

    await context.start();
    await context.service.tick();

    expect(context.resume).not.toHaveBeenCalled();
    expect(context.journal.get("session-1")?.phase).toBe("waiting_network");

    context.setOnline(true);
    await context.service.tick();

    expect(context.resume).toHaveBeenCalledExactlyOnceWith("session-1", "restart");
    expect(context.journal.size()).toBe(0);
  });

  it("parks a network failure without spending attempts and retries on reconnect", async () => {
    const context = harness({
      resume: async () => {
        throw new Error("connect ECONNRESET api.example.com");
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();

    expect(context.journal.get("session-1")).toMatchObject({
      phase: "waiting_network",
      attempts: 0,
      lastError: "connect ECONNRESET api.example.com",
    });
    expect(context.failures).toContain("network");

    // No connectivity verdict yet: the cooldown must hold the work instead of
    // spinning a retry every tick.
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(1);

    context.advance(30_000);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("continues immediately when connectivity returns", async () => {
    const context = harness({
      resume: async () => {
        throw new Error("fetch failed");
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();
    expect(context.journal.get("session-1")?.phase).toBe("waiting_network");

    context.service.releaseNetworkWait();
    context.setOnline(true);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("paces repeated network probes instead of retrying every tick", async () => {
    const context = harness({
      resume: async () => {
        throw new Error("error sending request for url (https://api.example.com): dns error");
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();
    expect(context.journal.get("session-1")).toMatchObject({
      phase: "waiting_network",
      networkWaits: 1,
    });

    context.advance(30_000);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.journal.get("session-1")?.networkWaits).toBe(2);

    // The second wait is longer: a minute-long outage must not cost 30 probes.
    context.advance(30_000);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(2);

    context.advance(31_000);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(3);
  });

  it("backs off a busy session instead of hammering it", async () => {
    const context = harness({
      resume: async () => {
        throw Object.assign(new Error("This session already has an active execution."), {
          code: "SESSION_BUSY",
        });
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();
    expect(context.journal.get("session-1")).toMatchObject({ attempts: 1, phase: "retrying" });

    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(1);

    context.advance(20_000);
    await context.service.tick();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget instead of retrying forever", async () => {
    const context = harness({
      maxAttempts: 2,
      resume: async () => {
        throw Object.assign(new Error("Execution shutdown is pending."), {
          code: "RECOVERY_REQUIRED",
        });
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();
    expect(context.journal.get("session-1")?.attempts).toBe(1);

    context.advance(60_000);
    await context.service.tick();
    expect(context.journal.get("session-1")).toBeUndefined();
  });

  it("drops work that only a new message could continue", async () => {
    const context = harness({
      resume: async () => {
        throw Object.assign(new Error("No LLM provider configured."), {
          code: "LLM_PROVIDER_NOT_CONFIGURED",
        });
      },
    });
    context.sessions.set("session-1", session("session-1"));

    await context.start();
    await context.service.tick();

    expect(context.journal.get("session-1")).toBeUndefined();
  });

  it("queues a network failure and clears a finished or user-stopped turn", async () => {
    const context = harness();
    context.sessions.set("session-1", session("session-1", { status: "interrupted" }));
    await context.start();

    context.service.handleSessionPatch("session-1", {
      status: "failed",
      blockedReason: "fetch failed",
    });
    expect(context.journal.get("session-1")).toMatchObject({
      cause: "network",
      phase: "queued",
    });

    context.service.handleSessionPatch("session-1", {
      status: "paused",
      blockedReason: "User requested session stop.",
    });
    expect(context.journal.get("session-1")).toBeUndefined();

    // A stop that only left its durable marker behind is still the user's call.
    context.sessions.set(
      "session-1",
      session("session-1", {
        status: "paused",
        sessionMetadata: { manualStop: { at: "2026-10-29T11:58:00.000Z" } },
      }),
    );
    context.service.handleSessionPatch("session-1", { status: "paused" });
    expect(context.journal.get("session-1")).toBeUndefined();

    context.service.handleSessionPatch("session-1", { status: "running" });
    context.service.handleSessionPatch("session-1", { status: "completed" });
    expect(context.journal.size()).toBe(0);
  });

  it("does not re-queue a session the user dismissed, even after a restart", async () => {
    const context = harness();
    context.sessions.set("session-1", session("session-1"));
    await context.start();

    context.service.dismiss("session-1");
    context.service.handleSessionPatch("session-1", { status: "interrupted" });
    await context.service.tick();
    expect(context.journal.size()).toBe(0);

    const restarted = new SessionAutoResumeService({
      journal: context.journal,
      sessions: {
        list: () => [...context.sessions.values()],
        get: (sessionId) => context.sessions.get(sessionId),
      },
      resume: context.resume,
      isOnline: () => true,
      startDelayMs: 0,
      tickIntervalMs: 60_000,
      now: () => NOW,
    });
    await context.journal.flush();
    await context.journal.load();
    restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await restarted.tick();
    expect(restarted.snapshot().items).toEqual([]);
    await restarted.stop();
  });

  it("does not disturb a session that is already executing", async () => {
    const context = harness();
    context.sessions.set("session-1", session("session-1", { activeRunId: "run-1" }));

    await context.start();
    await context.service.tick();

    expect(context.resume).not.toHaveBeenCalled();
    expect(context.journal.size()).toBe(0);
  });

  it("records executing sessions at shutdown so the next launch restores them", async () => {
    const context = harness();
    context.sessions.set("session-1", session("session-1", { status: "running" }));
    context.sessions.set("session-2", session("session-2", { status: "completed" }));
    context.sessions.set("child", session("child", { parentSessionId: "session-1" }));

    context.service.captureActiveSessions();

    expect(context.journal.list().map((record) => record.sessionId)).toEqual(["session-1"]);
    await context.service.stop();
  });

  it("drops a queued restart once the user has stopped that session", async () => {
    const context = harness();
    // Shutdown captures the row while the user's stop is still in flight.
    context.sessions.set("session-1", session("session-1", { status: "running" }));
    context.service.captureActiveSessions();
    expect(context.journal.get("session-1")?.cause).toBe("restart");

    // The stop then lands: the durable marker plus the interrupted status.
    context.sessions.set(
      "session-1",
      session("session-1", {
        status: "interrupted",
        resultSummary: "User stopped run.",
        sessionMetadata: { manualStop: { at: "2026-10-29T11:58:00.000Z" } },
      }),
    );

    await context.start();
    await context.service.tick();

    expect(context.resume).not.toHaveBeenCalled();
    expect(context.journal.size()).toBe(0);
  });

  it("reports the queue with session titles for the UI", async () => {
    const context = harness({ online: false });
    context.sessions.set("session-1", session("session-1", { title: "Ship it" }));
    await context.start();
    context.service.handleSessionPatch("session-1", { status: "interrupted" });

    expect(context.service.snapshot()).toMatchObject({
      online: false,
      items: [
        { sessionId: "session-1", title: "Ship it", phase: "waiting_network" },
      ],
    });
    await context.service.stop();
  });
});
