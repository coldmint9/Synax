import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

function createTree() {
  const root = agentSessionRuntime.create(plannerSessionInput);
  const child = agentSessionRuntime.create({
    ...plannerSessionInput,
    profileId: "explorer",
    parentSessionId: root.id,
    prompt: "Child prompt",
  });
  return { root, child };
}

describe("session archives", () => {
  const previousHistoryMode = process.env.SYNAX_VERSION_HISTORY;
  beforeEach(() => {
    process.env.SYNAX_VERSION_HISTORY = "legacy";
    resetAgentRuntimeFixtures();
  });
  afterAll(() => {
    process.env.SYNAX_VERSION_HISTORY = previousHistoryMode;
  });

  it("hides a whole tree and restores its referenced data", () => {
    const { root, child } = createTree();
    const eventCount = agentRuntimeStore.listEvents(root.id).length;

    const archived = agentRuntimeStore.archiveSessionTree(root.id);

    expect(archived.archiveBatchId).toBe(root.id);
    expect(archived.archivedSessionIds).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
    expect(() => agentRuntimeStore.getSession(root.id)).toThrow(/not found/i);
    expect(() => agentRuntimeStore.getSession(child.id)).toThrow(/not found/i);
    expect(() => agentRuntimeStore.listEvents(root.id)).toThrow(/not found/i);
    expect(agentRuntimeStore.listSessions({ projectId: root.projectId })).toEqual(
      [],
    );
    expect(agentRuntimeStore.listArchivedBatches().items).toMatchObject([
      { archiveBatchId: root.id, rootSessionId: root.id, sessionCount: 2 },
    ]);

    expect(agentRuntimeStore.restoreArchivedBatch(root.id)).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
    expect(agentRuntimeStore.getSession(root.id).id).toBe(root.id);
    expect(agentRuntimeStore.getSession(child.id).parentSessionId).toBe(root.id);
    expect(agentRuntimeStore.listEvents(root.id)).toHaveLength(eventCount);
    expect(agentRuntimeStore.listArchivedBatches().items).toEqual([]);
  });

  it("absorbs an archived child batch when its parent is archived", () => {
    const { root, child } = createTree();
    agentRuntimeStore.archiveSessionTree(child.id);
    expect(agentRuntimeStore.listArchivedBatches().items[0]).toMatchObject({
      archiveBatchId: child.id,
      sessionCount: 1,
    });

    agentRuntimeStore.archiveSessionTree(root.id);

    expect(agentRuntimeStore.listArchivedBatches().items).toMatchObject([
      { archiveBatchId: root.id, sessionCount: 2 },
    ]);
  });

  it("permanently deletes only an archived batch", () => {
    const { root, child } = createTree();
    expect(() => agentRuntimeStore.deleteArchivedBatch(root.id)).toThrow(
      /not found/i,
    );
    agentRuntimeStore.archiveSessionTree(root.id);

    expect(agentRuntimeStore.deleteArchivedBatch(root.id)).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
    const remaining = getRawSqlite()
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_runtime_sessions WHERE id IN (?, ?)",
      )
      .get(root.id, child.id) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("finds batches only after their retention cutoff", () => {
    const { root } = createTree();
    agentRuntimeStore.archiveSessionTree(root.id);
    getRawSqlite()
      .prepare(
        "UPDATE agent_runtime_sessions SET archived_at = ? WHERE archive_batch_id = ?",
      )
      .run("2026-09-01T00:00:00.000Z", root.id);

    expect(
      agentRuntimeStore.listExpiredArchiveBatchIds("2026-09-07T23:59:59.999Z"),
    ).toContain(root.id);
    expect(
      agentRuntimeStore.listExpiredArchiveBatchIds("2026-08-31T23:59:59.999Z"),
    ).not.toContain(root.id);
  });
});
