import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { agentRuntimeApi, type SessionBadgeRow } from "../../adapters/transport/agentRuntime";
import { projectSessionActivity, projectSessionBadge, useProjectSessionBadges } from "./projectSessionBadges";

const markerState = vi.hoisted(() => ({
  active: { projectId: "current", readSessionMarkers: {} as Record<string, string> },
  saved: {} as Record<string, Record<string, string>>,
}));
vi.mock("./state/agentSessionStore", () => ({
  useAgentSessionStore: (selector: (state: typeof markerState.active) => unknown) => selector(markerState.active),
  loadReadMarkers: (projectId: string) => markerState.saved[projectId] ?? {},
}));
vi.mock("../../adapters/transport/runtimeEventBus", () => ({ subscribe: () => () => {} }));

const now = Date.parse("2026-10-23T10:00:00Z");
const updatedAt = new Date(now - 1000).toISOString();
const row = (id: string, status: SessionBadgeRow["status"]): SessionBadgeRow => ({
  id, status, projectId: "workspace", updatedAt,
});

describe("workspace session activity", () => {
  it("uses persisted read markers for other workspaces and live markers after switching", async () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    markerState.active = { projectId: "current", readSessionMarkers: {} };
    markerState.saved = { other: { done: recent } };
    const request = vi.spyOn(agentRuntimeApi, "listSessionBadges").mockResolvedValue({ items: [
      { ...row("done", "completed"), projectId: "other", updatedAt: recent },
      { ...row("failed", "failed"), projectId: "other", updatedAt: recent },
    ] });
    const view = renderHook(() => useProjectSessionBadges(["current", "other"]));
    await waitFor(() => expect(view.result.current.badges.other.unreadFailed).toBe(1));
    expect(view.result.current.badges.other.unreadCompleted).toBe(0);
    markerState.active = { projectId: "other", readSessionMarkers: { done: recent, failed: recent } };
    view.rerender();
    expect(view.result.current.badges.other.total).toBe(0);
    markerState.saved.other = markerState.active.readSessionMarkers;
    markerState.active = { projectId: "current", readSessionMarkers: {} };
    view.rerender();
    expect(view.result.current.badges.other.total).toBe(0);
    view.unmount();
    request.mockRestore();
  });

  it("separates waiting, failed, running and unread completion without treating cancelled or paused work as success", () => {
    const badge = projectSessionBadge({
      sessions: [row("input", "waiting_input"), row("approval", "waiting_permission"),
        row("failed", "failed"), row("running", "running"), row("done", "completed"),
        row("cancelled", "cancelled"), row("paused", "paused"), row("interrupted", "interrupted")],
      readMarkers: {}, now,
    });
    expect(badge).toEqual({ waitingInput: 2, unreadFailed: 1, running: 1, unreadCompleted: 1, total: 5 });
  });

  it("keeps waiting visible after reading but clears finished results once read", () => {
    const badge = projectSessionBadge({
      sessions: [row("input", "waiting_input"), row("failed", "failed"), row("done", "completed")],
      readMarkers: { input: updatedAt, failed: updatedAt, done: updatedAt }, now,
    });
    expect(badge).toEqual({ waitingInput: 1, unreadFailed: 0, running: 0, unreadCompleted: 0, total: 1 });
  });

  it("does not mark an older projection unread and keeps unread results until they are read", () => {
    const badge = projectSessionBadge({
      sessions: [row("older", "failed"), row("newer", "completed")],
      readMarkers: { older: new Date(now).toISOString(), newer: new Date(now - 2000).toISOString() },
      now: now + 300_000,
    });
    expect(badge.unreadFailed).toBe(0);
    expect(badge.unreadCompleted).toBe(1);
    const unreadWithoutMarkers = projectSessionBadge({
      sessions: [row("failed", "failed"), row("done", "completed")],
      readMarkers: {}, now: now + 300_000,
    });
    expect(unreadWithoutMarkers.unreadFailed).toBe(1);
    expect(unreadWithoutMarkers.unreadCompleted).toBe(1);
  });

  it.each([
    [1, 2, 3, 4, "waiting", 1],
    [0, 2, 3, 4, "failed", 2],
    [0, 0, 3, 4, "running", 3],
    [0, 0, 0, 4, "unread", 4],
  ] as const)("prioritizes counts %s/%s/%s/%s as %s", (waitingInput, unreadFailed, running, unreadCompleted, status, count) => {
    expect(projectSessionActivity({ waitingInput, unreadFailed, running, unreadCompleted, total: waitingInput + unreadFailed + running + unreadCompleted }))
      .toEqual({ status, count });
  });

  it("hides an empty or unavailable activity summary", () => {
    expect(projectSessionActivity()).toBeUndefined();
    expect(projectSessionActivity({ waitingInput: 0, unreadFailed: 0, running: 0, unreadCompleted: 0, total: 0 })).toBeUndefined();
  });
});
