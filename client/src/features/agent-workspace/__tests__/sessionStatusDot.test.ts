import { describe, expect, it } from "vitest";
import {
  orderedSessionStatusTones,
  sessionStatusDot,
  sessionStatusTone,
  summarizeSessionDots,
} from "../sessionStatusDot";

describe("sessionStatusTone", () => {
  it.each([
    ["failed", "danger"],
    ["waiting_permission", "warning"],
    ["waiting_input", "warning"],
    ["interrupted", "warning"],
    ["paused", "warning"],
    ["running", "running"],
    ["stopping", "running"],
    ["queued", "running"],
    ["completed", "success"],
  ])("maps %s to %s", (status, tone) => {
    expect(sessionStatusTone(status)).toBe(tone);
  });

  it("leaves a cancelled or unknown session without a tone", () => {
    expect(sessionStatusTone("cancelled")).toBeNull();
    expect(sessionStatusTone("something-new")).toBeNull();
  });
});

describe("sessionStatusDot", () => {
  it("keeps yellow and blue while the status lasts, read or not", () => {
    expect(sessionStatusDot({ status: "waiting_input", unread: false })).toBe(
      "warning",
    );
    expect(sessionStatusDot({ status: "running", unread: false })).toBe(
      "running",
    );
    expect(sessionStatusDot({ status: "queued", unread: true })).toBe("running");
  });

  it("keeps a paused session's reminder until it is resumed", () => {
    expect(sessionStatusDot({ status: "paused", unread: false })).toBe(
      "warning",
    );
    expect(sessionStatusDot({ status: "interrupted", unread: false })).toBe(
      "warning",
    );
  });

  it("hides a finished result once it is read", () => {
    expect(sessionStatusDot({ status: "completed", unread: true })).toBe(
      "success",
    );
    expect(sessionStatusDot({ status: "completed", unread: false })).toBeNull();
    expect(sessionStatusDot({ status: "failed", unread: true })).toBe("danger");
    expect(sessionStatusDot({ status: "failed", unread: false })).toBeNull();
  });

  it("has no dot for a cancelled session, read or not", () => {
    expect(sessionStatusDot({ status: "cancelled", unread: true })).toBeNull();
    expect(sessionStatusDot({ status: "cancelled", unread: false })).toBeNull();
  });
});

describe("summarizeSessionDots", () => {
  it("counts only the sessions that still show a dot", () => {
    expect(
      summarizeSessionDots([
        { status: "completed", unread: true },
        { status: "completed", unread: false },
        { status: "failed", unread: false },
        { status: "waiting_input", unread: false },
        { status: "running", unread: false },
      ]),
    ).toEqual({ success: 1, warning: 1, running: 1 });
  });

  it("returns no counts for an empty group", () => {
    expect(summarizeSessionDots([])).toEqual({});
  });
});

describe("orderedSessionStatusTones", () => {
  it("orders the states present by triage urgency", () => {
    expect(
      orderedSessionStatusTones({
        success: 1,
        running: 1,
        danger: 1,
        warning: 1,
      }),
    ).toEqual(["warning", "danger", "running", "success"]);
  });

  it("skips states the group does not have", () => {
    expect(orderedSessionStatusTones({ success: 3 })).toEqual(["success"]);
    expect(orderedSessionStatusTones({})).toEqual([]);
  });
});
