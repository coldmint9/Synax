import { describe, expect, it } from "vitest";
import type { AgentProfile, AgentSession } from "../contracts.js";
import {
  isPlanningReadTool,
  isToolMountedForSession,
  modelCanUseTool,
  profileCanUseTool,
} from "../tool-mount-policy.js";

function sessionWithMode(
  mode: "chat" | "plan" | "goal",
  planStatus?: string,
): AgentSession {
  return {
    id: "s1",
    parentSessionId: null,
    profileId: "synax",
    sessionMetadata: { mode, ...(planStatus ? { plan: { status: planStatus } } : {}) },
  } as unknown as AgentSession;
}

describe("tool mount policy", () => {
  it('does not give a scoped merge worker native, MCP, skill or mountAllTools escapes', () => {
    const profile = { id: 'git-merge-worker', allowedCapabilities: ['git.merge.worker.read'], mountAllTools: true } as AgentProfile;
    expect(modelCanUseTool(profile, { id: 'git.merge.worker.read', category: 'read' })).toBe(true);
    for (const tool of [
      { id: 'agent.execute', category: 'task' }, { id: 'agent.discover', category: 'read' },
      { id: 'bash', category: 'shell' }, { id: 'file.write', category: 'write' },
      { id: 'unbound.mcp', category: 'mcp' }, { id: 'skill.load', category: 'skill' },
      { id: 'work.checkpoint', category: 'task' }, { id: 'presentation.select', category: 'task' },
    ]) {
      expect(modelCanUseTool(profile, tool), tool.id).toBe(false);
      expect(profileCanUseTool(profile, tool), tool.id).toBe(false);
    }
  });
  it("keeps webSearch mounted in plan mode so explicitly requested research can run", () => {
    expect(isPlanningReadTool("webSearch")).toBe(true);
    expect(isPlanningReadTool("design.write")).toBe(true);
    expect(isPlanningReadTool("design.preview")).toBe(true);
    expect(isToolMountedForSession(sessionWithMode("chat"), { id: "plan.propose" })).toBe(true);

    const webSearch = { id: "webSearch" };
    expect(isToolMountedForSession(sessionWithMode("chat"), webSearch)).toBe(
      true,
    );
    expect(isToolMountedForSession(sessionWithMode("plan"), webSearch)).toBe(
      true,
    );

    // Write tools stay unmounted while planning — the guard is unchanged.
    expect(
      isToolMountedForSession(sessionWithMode("plan"), { id: "file.write" }),
    ).toBe(false);
    expect(
      isToolMountedForSession(sessionWithMode("plan"), { id: "bash" }),
    ).toBe(false);
  });

  it("keeps webSearch mounted in goal mode before and after plan approval", () => {
    const webSearch = { id: "webSearch" };
    expect(
      isToolMountedForSession(sessionWithMode("goal", "draft"), webSearch),
    ).toBe(true);
    expect(
      isToolMountedForSession(sessionWithMode("goal", "approved"), webSearch),
    ).toBe(true);
  });

  it("hides subagent delegation when the session task override is denied", () => {
    const session = sessionWithMode("chat");
    session.sessionMetadata = {
      ...session.sessionMetadata,
      permissionOverrides: { task: "deny" },
    };
    expect(
      isToolMountedForSession(session, { id: "subagent.delegate" }),
    ).toBe(false);
    expect(isToolMountedForSession(session, { id: "task.create" })).toBe(true);
  });
});
