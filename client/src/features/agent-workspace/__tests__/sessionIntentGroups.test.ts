import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import type { SessionTreeNode } from "../useSessionList";
import { buildIntentSessionGroups } from "../sessionIntentGroups";

const UNCATEGORIZED = "未分类";

function node(
  id: string,
  sessionMetadata: Record<string, unknown> | null = null,
  status: AgentSession["status"] = "completed",
): SessionTreeNode {
  const session: AgentSession = {
    id,
    projectId: "p1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status,
    title: id,
    prompt: id,
    contextSnapshotId: null,
    thinkingMode: "standard",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata,
  };
  return { session, depth: 0, children: [], expanded: false };
}

const ids = (nodes: SessionTreeNode[]) => nodes.map((item) => item.session.id);

const build = (
  nodes: SessionTreeNode[],
  isUnread: (session: AgentSession) => boolean = () => false,
) => buildIntentSessionGroups(nodes, { uncategorized: UNCATEGORIZED, isUnread });

describe("buildIntentSessionGroups", () => {
  it("keeps the newest category first and trails the uncategorized bucket", () => {
    const groups = build([
      node("a", { intentCategory: "缺陷修复" }),
      node("b", { intentCategory: "需求澄清" }),
      node("c", null),
      node("d", { intentCategory: "缺陷修复" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "缺陷修复",
      "需求澄清",
      UNCATEGORIZED,
    ]);
    expect(ids(groups[0].sessions)).toEqual(["a", "d"]);
    expect(groups.map((group) => group.count)).toEqual([2, 1, 1]);
    expect(groups.map((group) => group.sessions.length)).toEqual([2, 1, 1]);
    // Every category owns a disclosure toggle, collapsed state comes from the list.
    expect(groups.every((group) => group.collapsible === true)).toBe(true);
    expect(groups.every((group) => group.collapsed === false)).toBe(true);
  });

  it("maps a missing or non-text category onto the uncategorized bucket", () => {
    const groups = build([
      node("a", { intentCategory: "" }),
      node("b", { intentCategory: 42 }),
      node("c", null),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNCATEGORIZED);
    expect(ids(groups[0].sessions)).toEqual(["a", "b", "c"]);
  });

  it("ignores metadata keys other than the intent category", () => {
    const groups = build([
      node("a", { intentCategory: "缺陷修复", pinned: true, source: "session-page" }),
      node("b", { pinned: false }),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "缺陷修复",
      UNCATEGORIZED,
    ]);
  });

  it("summarises the dots each category still has to show", () => {
    const groups = build(
      [
        node("a", { intentCategory: "缺陷修复" }, "waiting_input"),
        node("b", { intentCategory: "缺陷修复" }, "running"),
        node("c", { intentCategory: "缺陷修复" }, "running"),
        node("d", { intentCategory: "需求澄清" }, "completed"),
        node("e", { intentCategory: "需求澄清" }, "cancelled"),
      ],
      () => true,
    );

    expect(groups[0].statusCounts).toEqual({ warning: 1, running: 2 });
    // A cancelled row shows no dot, so it must not appear in the mix.
    expect(groups[1].statusCounts).toEqual({ success: 1 });
  });

  it("drops green and red once the rows are read, keeping live states", () => {
    const groups = build(
      [
        node("a", { intentCategory: "缺陷修复" }, "completed"),
        node("b", { intentCategory: "缺陷修复" }, "failed"),
        node("c", { intentCategory: "缺陷修复" }, "waiting_permission"),
        node("d", { intentCategory: "缺陷修复" }, "queued"),
      ],
      () => false,
    );

    expect(groups[0].statusCounts).toEqual({ warning: 1, running: 1 });
  });

  it("returns no groups for an empty list", () => {
    expect(build([])).toEqual([]);
  });
});
