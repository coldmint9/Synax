import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../contracts.js";
import {
  autoResumeBackoffMs,
  clearsAutoResume,
  isNetworkFailure,
  isUserStopReason,
  planSessionResume,
  resumeDecisionForPatch,
} from "../contracts.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "session-1",
    projectId: "project-1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status: "interrupted",
    title: "Ship the feature",
    prompt: "Ship the feature",
    contextSnapshotId: null,
    thinkingMode: "standard",
    permissionRules: [],
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T11:55:00.000Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  };
}

describe("isNetworkFailure", () => {
  it.each([
    "fetch failed",
    "connect ECONNREFUSED 10.0.0.3:443",
    "getaddrinfo ENOTFOUND api.example.com",
    "socket hang up",
    "Request timed out",
    "HTTP 503 Service Unavailable",
    // A stream the provider closed mid-body ends exactly like an unreachable
    // endpoint: the turn stopped, nothing the user wrote is wrong.
    "HttpError: Http client error: error decoding response body",
    "stream failed: incomplete message",
    "unexpected end of stream",
  ])("treats %s as transport trouble", (reason) => {
    expect(isNetworkFailure(reason)).toBe(true);
  });

  it.each([
    "Model does not support tools",
    "Invalid API key",
    "Context limit exceeded",
    "",
    undefined,
    null,
  ])("does not treat %s as transport trouble", (reason) => {
    expect(isNetworkFailure(reason)).toBe(false);
  });
});

describe("isUserStopReason", () => {
  it("recognises an explicit stop and archive", () => {
    expect(isUserStopReason("User requested session stop.")).toBe(true);
    expect(isUserStopReason("Session archived by user.")).toBe(true);
    expect(isUserStopReason("Runtime host is shutting down.")).toBe(false);
    expect(isUserStopReason(null)).toBe(false);
  });
});

describe("planSessionResume", () => {
  it("restores work a previous host never settled", () => {
    expect(planSessionResume(session({ status: "running" }), { now: NOW })).toEqual({
      resume: true,
      cause: "restart",
    });
    expect(planSessionResume(session({ status: "interrupted" }), { now: NOW })).toEqual({
      resume: true,
      cause: "restart",
    });
  });

  it("restores a session whose turn failed on the network", () => {
    expect(
      planSessionResume(
        session({ status: "failed", blockedReason: "fetch failed" }),
        { now: NOW },
      ),
    ).toEqual({ resume: true, cause: "network" });
  });

  it("restores a session whose reply stream was truncated mid-answer", () => {
    expect(
      planSessionResume(
        session({
          status: "failed",
          blockedReason: "HttpError: Http client error: error decoding response body",
        }),
        { now: NOW },
      ),
    ).toEqual({ resume: true, cause: "network" });
  });

  it("leaves settled, waiting and unrelated sessions alone", () => {
    for (const status of [
      "completed",
      "cancelled",
      "waiting_permission",
      "waiting_input",
    ] as const)
      expect(planSessionResume(session({ status }), { now: NOW })).toEqual({ resume: false });
  });

  it("does not repeat a failure the user cannot fix by retrying", () => {
    expect(
      planSessionResume(
        session({ status: "failed", blockedReason: "Invalid API key" }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
  });

  it("honours an explicit user stop", () => {
    expect(
      planSessionResume(
        session({ status: "paused", blockedReason: "User requested session stop." }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
    // The runtime keeps the durable marker even when the human-readable reason
    // only survives on the summary.
    expect(
      planSessionResume(
        session({ status: "paused", sessionMetadata: { manualStop: { at: "2026-10-29T11:00:00.000Z" } } }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
    expect(
      planSessionResume(
        session({ status: "interrupted", resultSummary: "User requested session stop." }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
  });

  it("skips child sessions, side chats and archived rows", () => {
    expect(
      planSessionResume(session({ parentSessionId: "parent-1" }), { now: NOW }),
    ).toEqual({ resume: false });
    expect(
      planSessionResume(
        session({ sessionMetadata: { subagentKind: "side-chat" } }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
    expect(
      planSessionResume(
        session({ sessionMetadata: { archivedAt: "2026-10-29T11:00:00.000Z" } }),
        { now: NOW },
      ),
    ).toEqual({ resume: false });
  });

  it("does not resurrect work from a previous day", () => {
    expect(
      planSessionResume(
        session({ status: "running", updatedAt: "2026-10-27T09:00:00.000Z" }),
        { now: NOW, maxAgeMs: 12 * 60 * 60 * 1_000 },
      ),
    ).toEqual({ resume: false });
  });
});

describe("session patch translation", () => {
  it("clears the queue when a turn finishes or the user stops it", () => {
    expect(clearsAutoResume("completed", null)).toBe(true);
    expect(clearsAutoResume("cancelled", null)).toBe(true);
    expect(clearsAutoResume("paused", "User requested session stop.")).toBe(true);
    expect(clearsAutoResume("failed", "Invalid API key")).toBe(true);
    expect(clearsAutoResume("failed", "fetch failed")).toBe(false);
    expect(clearsAutoResume("running", null)).toBe(false);
  });

  it("queues network failures and restart interruptions", () => {
    expect(resumeDecisionForPatch("failed", "fetch failed")).toBe("network");
    expect(resumeDecisionForPatch("failed", "Invalid API key")).toBeNull();
    expect(resumeDecisionForPatch("interrupted", "Runtime host is shutting down.")).toBe(
      "restart",
    );
    expect(resumeDecisionForPatch("paused", "User requested session stop.")).toBeNull();
  });
});

describe("autoResumeBackoffMs", () => {
  it("backs off further with every attempt and stays bounded", () => {
    const first = autoResumeBackoffMs(1);
    const second = autoResumeBackoffMs(2);
    const last = autoResumeBackoffMs(50);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThanOrEqual(last);
    expect(last).toBeLessThanOrEqual(15 * 60 * 1_000);
  });
});
