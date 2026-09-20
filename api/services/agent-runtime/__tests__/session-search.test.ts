import { beforeEach, describe, expect, it } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { searchSessions } from "../session-search.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import type { AgentSession } from "../contracts.js";

function seed(
  id: string,
  projectId = "alpha",
  parentSessionId: string | null = null,
) {
  agentRuntimeStore.createSession({
    id,
    projectId,
    parentSessionId,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status: "completed",
    title: "Ordinary title",
    prompt: "Initial request",
    contextSnapshotId: null,
    thinkingMode: "standard",
    permissionRules: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
  } as AgentSession);
}
function message(id: string, sessionId: string, content: string) {
  agentRuntimeStore.appendMessage({
    id,
    sessionId,
    content,
    role: "assistant",
    runId: null,
    stepId: null,
    createdAt: "2026-01-01",
    metadata: {},
  });
}

describe("workspace full-text session search", () => {
  beforeEach(resetAgentRuntimeFixtures);
  it("finds persisted message text, scopes projects, and returns matching context", () => {
    seed("old");
    seed("other", "beta");
    seed("child", "alpha", "old");
    message(
      "m1",
      "old",
      "prefix ".repeat(100) + "全文检索 needle works" + " suffix".repeat(100),
    );
    message("m2", "other", "全文检索 needle");
    message("m3", "child", "child-only needle");
    for (const q of ["全文检索", "全文", "全", "NEEDLE"]) {
      const result = searchSessions("alpha", q);
      expect(result.items.map((item) => item.session.id)).toEqual(["old"]);
      expect(result.items[0].snippet.toLowerCase()).toContain(q.toLowerCase());
    }
    expect(searchSessions("alpha", "child-only").items).toEqual([]);
  });
  it("treats punctuation as literal text and deduplicates messages before paging", () => {
    for (const id of ["a", "b", "c"]) {
      seed(id);
      message(id + "1", id, 'literal a%_b "quote"');
      message(id + "2", id, 'literal a%_b "quote"');
    }
    expect(
      searchSessions("alpha", "a%_b", 2).items.map((item) => item.session.id),
    ).toEqual(["a", "b"]);
    expect(searchSessions("alpha", "a%_b", 2).hasMore).toBe(true);
    expect(
      searchSessions("alpha", "a%_b", 2, 2).items.map(
        (item) => item.session.id,
      ),
    ).toEqual(["c"]);
    expect(searchSessions("alpha", '"quote"').items).toHaveLength(3);
    expect(searchSessions("alpha", " ").items).toEqual([]);
  });
  it("keeps long literal matches intact in the returned excerpt", () => {
    seed("long");
    const query = "全文检索".repeat(40);
    message("long-message", "long", "前置内容".repeat(60) + query + "后续内容");
    expect(searchSessions("alpha", query).items[0].snippet).toContain(query);
  });
  it("keeps indexes in sync through replace, update and deletion", () => {
    seed("a");
    message("m", "a", "obsolete match");
    message("m", "a", "replacement match");
    expect(searchSessions("alpha", "obsolete").items).toEqual([]);
    expect(searchSessions("alpha", "replacement").items).toHaveLength(1);
    getRawSqlite()
      .prepare("UPDATE agent_runtime_sessions SET title = ? WHERE id = ?")
      .run("Changed title", "a");
    expect(searchSessions("alpha", "Changed").items).toHaveLength(1);
    getRawSqlite()
      .prepare("DELETE FROM agent_runtime_messages WHERE id = ?")
      .run("m");
    expect(searchSessions("alpha", "replacement").items).toEqual([]);
    getRawSqlite()
      .prepare("DELETE FROM agent_runtime_sessions WHERE id = ?")
      .run("a");
    expect(searchSessions("alpha", "Changed").items).toEqual([]);
  });
});
