import { describe, expect, it } from "vitest";
import type { AgentSession } from "../contracts.js";
import {
  isPlanningReadTool,
  isToolMountedForSession,
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
  it("keeps webSearch mounted in plan mode so explicitly requested research can run", () => {
    expect(isPlanningReadTool("webSearch")).toBe(true);
    expect(isPlanningReadTool("design.write")).toBe(true);
    expect(isPlanningReadTool("design.preview")).toBe(true);

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
});
