import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
import {
  classifySession,
  isAgentWorkspaceSession,
  isWorkflowSession,
  listRootSessions,
} from "../sessionBuckets";

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    projectId: "p1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "goal",
    status: "completed",
    title: null,
    prompt: "test",
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
    sessionMetadata: null,
    ...overrides,
  };
}

describe("sessionBuckets", () => {
  it.each(["agent-dock", "goal-dock"])(
    "restores the %s session source",
    (source) => {
      expect(
        isAgentWorkspaceSession(
          makeSession({ profileId: "synax", sessionMetadata: { source } }),
        ),
      ).toBe(true);
    },
  );

  it("detects managed workspace sessions and legacy goal profiles", () => {
    expect(isAgentWorkspaceSession(makeSession({ profileId: "goal" }))).toBe(
      true,
    );
    expect(
      isAgentWorkspaceSession(
        makeSession({
          profileId: "synax",
          sessionMetadata: { mode: "goal", source: "goal-dock" },
        }),
      ),
    ).toBe(true);
    expect(
      isAgentWorkspaceSession(
        makeSession({
          profileId: "synax",
          sessionMetadata: { mode: "plan_node", source: "plan-execution" },
        }),
      ),
    ).toBe(true);
    expect(
      isAgentWorkspaceSession(
        makeSession({
          profileId: "synax",
          sessionMetadata: { mode: "goal", source: "session-page" },
        }),
      ),
    ).toBe(true);
    expect(
      isAgentWorkspaceSession(
        makeSession({
          profileId: "goal",
          sessionMetadata: { source: "goal-dock" },
        }),
      ),
    ).toBe(true);
  });

  it("does not classify unbound chat sessions as managed workspace sessions", () => {
    expect(
      isAgentWorkspaceSession(
        makeSession({
          profileId: "synax",
          sessionMetadata: { mode: "chat" },
        }),
      ),
    ).toBe(false);
  });

  it("detects wiki workflow sessions", () => {
    expect(isWorkflowSession(makeSession({ profileId: "wiki-planner" }))).toBe(
      true,
    );
    expect(isWorkflowSession(makeSession({ profileId: "wiki-writer" }))).toBe(
      true,
    );
    expect(isWorkflowSession(makeSession({ profileId: "wiki-refresh" }))).toBe(
      true,
    );
    expect(
      isWorkflowSession(
        makeSession({
          profileId: "explorer",
          sessionMetadata: { snapshotId: "snap-1", phase: "planner" },
        }),
      ),
    ).toBe(true);
    expect(isWorkflowSession(makeSession({ profileId: "plan-planner" }))).toBe(
      true,
    );
  });

  it("classifies interactive sessions as sessions view bucket but not managed workspace sessions", () => {
    expect(
      isAgentWorkspaceSession(makeSession({ profileId: "explorer" })),
    ).toBe(false);
    expect(classifySession(makeSession({ profileId: "explorer" }))).toBe(
      "sessions",
    );
    expect(isAgentWorkspaceSession(makeSession({ profileId: "goal" }))).toBe(
      true,
    );
  });

  it("classifies automation sessions as workflow view", () => {
    expect(classifySession(makeSession({ profileId: "wiki-verifier" }))).toBe(
      "workflow",
    );
  });

  it("drops subagent child sessions and preserves root sessions in order", () => {
    const parent = makeSession({ id: "parent", profileId: "goal" });
    const child = makeSession({
      id: "child",
      parentSessionId: "parent",
      profileId: "explorer",
      sessionMetadata: { mode: "plan" },
    });
    const other = makeSession({ id: "other", profileId: "goal" });

    expect(listRootSessions([parent, child, other]).map((s) => s.id)).toEqual([
      "parent",
      "other",
    ]);
  });

  it("hides a subagent child session even when it matches the sessions view", () => {
    const child = makeSession({
      id: "child",
      parentSessionId: "parent",
      profileId: "explorer",
      sessionMetadata: { mode: "plan" },
    });

    expect(isAgentWorkspaceSession(child)).toBe(true);
    expect(listRootSessions([child])).toEqual([]);
  });

  it("keeps list counts aligned with the root-only filter", () => {
    const rootGoal = makeSession({ id: "root-goal", profileId: "goal" });
    const rootChat = makeSession({
      id: "root-chat",
      profileId: "synax",
      sessionMetadata: { mode: "chat" },
    });
    const child = makeSession({
      id: "child",
      parentSessionId: "root-goal",
      profileId: "explorer",
      sessionMetadata: { mode: "plan" },
    });

    const roots = listRootSessions([rootGoal, rootChat, child]);

    expect(roots.map((s) => s.id)).toEqual(["root-goal", "root-chat"]);
    expect(roots.filter(isAgentWorkspaceSession).map((s) => s.id)).toEqual([
      "root-goal",
    ]);
    expect(roots.filter(isWorkflowSession)).toEqual([]);
  });
});
