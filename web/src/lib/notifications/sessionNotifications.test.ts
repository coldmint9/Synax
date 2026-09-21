import { describe, expect, it } from "vitest";
import {
  SessionNotificationTracker,
  sessionNotificationPayload,
  validNotificationTarget,
} from "./sessionNotifications";
import type { AgentSession } from "../api/agentRuntime";

describe("session notification transitions and copy", () => {
  it("only creates new episodes for a status transition or a different request/completion", () => {
    const tracker = new SessionNotificationTracker();
    const state = tracker.observe("s", {
      status: "waiting_permission",
      pendingResumeToken: "p1",
    });
    expect(tracker.observe("s", { status: "waiting_permission" })).toBe(state);
    expect(
      tracker.observe("s", {
        status: "waiting_permission",
        pendingResumeToken: "p1",
        title: "Renamed",
      }),
    ).toBe(state);
    expect(tracker.observe("s", { title: "Renamed" })).toBeUndefined();
    const next = tracker.observe("s", {
      status: "waiting_permission",
      pendingResumeToken: "p2",
    });
    expect(next).not.toBe(state);
    expect(tracker.isCurrent("s", state!)).toBe(false);
    tracker.observe("s", { status: "running" });
    const completed = tracker.observe("s", {
      status: "completed",
      completedAt: "t1",
    });
    expect(
      tracker.observe("s", { status: "completed", completedAt: "t1" }),
    ).toBe(completed);
    expect(
      tracker.observe("s", { status: "completed", completedAt: "t2" }),
    ).not.toBe(completed);
    tracker.remove("s");
    expect(tracker.isCurrent("s", next!)).toBe(false);
  });
  it("builds bounded localized plain text without putting private prompts into fallback titles", () => {
    const session = {
      id: "s",
      projectId: "p",
      title: "new session",
      prompt: "SECRET TASK PROMPT",
      resultSummary: "**Done**\n```js\nsecretCode()\n```\n" + "x".repeat(1000),
      completedAt: "t",
    } as AgentSession;
    const notification = sessionNotificationPayload(
      session,
      "completed",
      "en",
      1,
    );
    expect(notification.title).toBe("Synax · Session completed");
    expect(notification.body).toContain("Done");
    expect(notification.body).not.toContain("secretCode");
    expect(JSON.stringify(notification)).not.toContain("SECRET TASK PROMPT");
    expect(notification.body.length).toBeLessThan(300);
    expect(validNotificationTarget(notification)).toBe(true);
    expect(
      validNotificationTarget({
        ...notification,
        sessionId: "s?session=other",
      }),
    ).toBe(false);
  });
});
