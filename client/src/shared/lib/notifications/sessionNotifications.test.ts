import { describe, expect, it } from "vitest";
import {
  notificationKind,
  notificationMarker,
  SessionNotificationTracker,
  sessionNotificationPayload,
  validNotificationTarget,
} from "./sessionNotifications";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";

describe("suspended and settled session notices", () => {
  it.each([
    ["waiting_input", "input"],
    ["waiting_permission", "approval"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["paused", "paused"],
    ["interrupted", "interrupted"],
    ["cancelled", "cancelled"],
    ["running", undefined],
    ["stopping", undefined],
    ["queued", undefined],
  ] as const)("maps %s to %s", (status, kind) => {
    expect(notificationKind(status)).toBe(kind);
  });

  it("identifies a question by its resume token and a settled run by its completion time", () => {
    expect(
      notificationMarker("waiting_input", {
        pendingResumeToken: "request-1",
        completedAt: "2026-10-27T00:00:00Z",
      }),
    ).toBe("request-1");
    expect(
      notificationMarker("paused", { pendingResumeToken: null, completedAt: null }),
    ).toBeUndefined();
    expect(
      notificationMarker("cancelled", { completedAt: "2026-10-27T00:00:00Z" }),
    ).toBe("2026-10-27T00:00:00Z");
  });

  it("notifies again when a paused session is resumed and parked a second time", () => {
    const tracker = new SessionNotificationTracker();
    const first = tracker.observe("s", {
      status: "paused",
      completedAt: "2026-10-27T00:00:00Z",
    });
    expect(first?.status).toBe("paused");
    expect(
      tracker.observe("s", { status: "paused", completedAt: "2026-10-27T00:00:00Z" }),
    ).toBe(first);
    tracker.observe("s", { status: "running" });
    expect(
      tracker.observe("s", { status: "paused", completedAt: "2026-10-27T01:00:00Z" }),
    ).not.toBe(first);
  });
});

describe("session notification transitions and copy", () => {
  it.each([
    "completed",
    "input",
    "approval",
    "failed",
    "paused",
    "interrupted",
    "cancelled",
  ] as const)("brands %s fallback notifications in both locales without changing routing", (kind) => {
    for (const locale of ["zh", "en"] as const) {
      const session = { id: "s", projectId: "p", title: "new session" } as AgentSession;
      const payload = sessionNotificationPayload(session, kind, locale, 1);
      expect(payload.title).toMatch(/^Synax · /);
      expect(payload).toMatchObject({ sessionId: "s", projectId: "p", kind });
      expect(sessionNotificationPayload({ ...session, title: "My project" }, kind, locale, 1).title).toBe("My project");
    }
  });
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
