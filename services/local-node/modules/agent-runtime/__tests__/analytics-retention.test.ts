import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RetainedAnalyticsStore,
  type RetiredSessionEntry,
} from "../../../infrastructure/analytics/retained-analytics-store.js";
import { retiredSessionEntry } from "../analytics-retention.js";
import type { AgentSession } from "../contracts.js";

const now = "2026-10-30T10:00:00.000Z";
const analytics = { version: 3, steps: 4, usage: { input: 900, output: 100 } };
const contextUsage = { version: 1, source: "provider", total: 1000 };

function entry(overrides: Partial<RetiredSessionEntry> = {}): RetiredSessionEntry {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    title: "Session",
    sessionGroup: null,
    parentSessionId: null,
    status: "completed",
    createdAt: now,
    completedAt: now,
    updatedAt: now,
    retiredAt: now,
    retiredReason: "archived",
    analytics,
    contextUsage,
    ...overrides,
  };
}

describe("retained analytics ledger", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "synax-retained-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accumulates entries per project and refreshes one session in place", async () => {
    const store = new RetainedAnalyticsStore(directory);
    await store.upsert("project-1", [entry()]);
    await store.upsert("project-1", [entry({ sessionId: "session-2" })]);
    expect((await store.read("project-1")).map((item) => item.sessionId).sort()).toEqual([
      "session-1",
      "session-2",
    ]);
    await store.upsert("project-1", [
      entry({ title: "Renamed", retiredReason: "deleted" }),
    ]);
    const rows = await store.read("project-1");
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.sessionId === "session-1")).toMatchObject({
      title: "Renamed",
      retiredReason: "deleted",
    });
  });

  it("reads an unknown project, a corrupt file and a missing directory as empty", async () => {
    await expect(
      new RetainedAnalyticsStore(path.join(directory, "missing")).read("project-1"),
    ).resolves.toEqual([]);
    const store = new RetainedAnalyticsStore(directory);
    await store.upsert("project-2", [entry({ projectId: "project-2" })]);
    const [file] = await readdir(directory);
    await writeFile(path.join(directory, file), "{not json");
    await expect(store.read("project-2")).resolves.toEqual([]);
    await expect(store.read("project-1")).resolves.toEqual([]);
  });

  it("ignores a ledger file that belongs to another project", async () => {
    const store = new RetainedAnalyticsStore(directory);
    await store.upsert("project-1", [entry()]);
    await mkdir(directory, { recursive: true });
    const [file] = await readdir(directory);
    const parsed = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    await writeFile(
      path.join(directory, file),
      JSON.stringify({ ...parsed, projectId: "project-9" }),
    );
    await expect(store.read("project-1")).resolves.toEqual([]);
  });

  it("serializes concurrent writers without losing entries", async () => {
    const store = new RetainedAnalyticsStore(directory);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.upsert("project-1", [entry({ sessionId: `session-${index}` })]),
      ),
    );
    expect(await store.read("project-1")).toHaveLength(8);
  });

  it("writes atomically with private file permissions", async () => {
    const store = new RetainedAnalyticsStore(directory);
    await store.upsert("project-1", [entry()]);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".json")).toBe(true);
    expect((await stat(path.join(directory, files[0]))).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(path.join(directory, files[0]), "utf8"))
        .projectId,
    ).toBe("project-1");
  });
});

describe("retiredSessionEntry", () => {
  const session = {
    id: "session-1",
    projectId: "project-1",
    title: "   ",
    prompt: "Explore the repository",
    status: "completed",
    createdAt: now,
    completedAt: now,
    updatedAt: now,
    parentSessionId: null,
    sessionMetadata: {
      runtimeAnalytics: analytics,
      contextUsage,
      intentCategory: "功能需求",
    },
  } as unknown as AgentSession;

  it("keeps the projected analytics verbatim for the totals", () => {
    expect(retiredSessionEntry(session, "archived")).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
      title: "Explore the repository",
      sessionGroup: "功能需求",
      retiredReason: "archived",
      analytics,
      contextUsage,
    });
  });

  it("survives empty, broken or unusable session metadata", () => {
    expect(
      retiredSessionEntry(
        { ...session, sessionMetadata: undefined } as unknown as AgentSession,
        "deleted",
      ),
    ).toMatchObject({
      analytics: null,
      contextUsage: null,
      retiredReason: "deleted",
    });
    expect(
      retiredSessionEntry(
        {
          ...session,
          sessionMetadata: { runtimeAnalytics: 7, contextUsage: "x" },
        } as unknown as AgentSession,
        "archived",
      ),
    ).toMatchObject({ analytics: 7, contextUsage: "x" });
    expect(
      retiredSessionEntry({ id: "", projectId: "p" } as AgentSession, "archived"),
    ).toBeNull();
  });
});
