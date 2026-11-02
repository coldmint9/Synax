import { describe, expect, it } from "vitest";
import type { AgentSession } from "../contracts.js";
import { isToolMountedForSession } from "../tool-mount-policy.js";

function session(mode: string): AgentSession {
  return {
    id: `session-${mode}`,
    projectId: "project-1",
    profileId: "synax",
    status: "idle",
    prompt: "",
    sessionMetadata: { mode },
    childSessionIds: [],
  } as unknown as AgentSession;
}

describe("super tool mounting", () => {
  it("mounts super tools only inside the super workflow", () => {
    for (const id of ["super.plan", "super.message", "super.close"]) {
      expect(isToolMountedForSession(session("super"), { id })).toBe(true);
      expect(isToolMountedForSession(session("chat"), { id })).toBe(false);
      expect(isToolMountedForSession(session("goal"), { id })).toBe(false);
    }
  });

  it("keeps ordinary tools mounted outside the super workflow", () => {
    expect(isToolMountedForSession(session("chat"), { id: "file.read" })).toBe(
      true,
    );
    expect(isToolMountedForSession(session("super"), { id: "file.write" })).toBe(
      true,
    );
  });

  it("leaves ad-hoc delegation unmounted for the super planner", () => {
    for (const id of ["subagent.delegate", "subagent.lifecycle"]) {
      expect(isToolMountedForSession(session("super"), { id })).toBe(false);
      expect(isToolMountedForSession(session("chat"), { id })).toBe(true);
    }
  });

  it("never mounts super tools inside a delegated child", () => {
    const child = {
      ...session("super"),
      id: "child-1",
      parentSessionId: "session-super",
    } as AgentSession;
    for (const id of ["super.plan", "super.message", "super.close"]) {
      expect(isToolMountedForSession(child, { id })).toBe(false);
    }
  });
});
