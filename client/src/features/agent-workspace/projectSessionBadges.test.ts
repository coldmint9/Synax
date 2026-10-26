import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
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
  beforeEach(() => {
    markerState.active = { projectId: "current", readSessionMarkers: {} };
    markerState.saved = {};
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses persisted read markers for other workspaces and live markers after switching", async () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    markerState.active = { projectId: "current", readSessionMarkers: {} };
    markerState.saved = { other: { done: recent } };
    const request = vi.spyOn(agentRuntimeApi, "listSessionBadges").mockResolvedValue({ items: [
      { ...row("done", "completed"), projectId: "other", updatedAt: recent },
      { ...row("failed", "failed"), projectId: "other", updatedAt: recent },
    ] });
    const view = renderHook(() => useProjectSessionBadges(["current", "other"], markerState.active.projectId));
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

  it("clears every badge category on entry without reading individual conversations, and persists after leaving", async () => {
    const items = [row("input", "waiting_input"), row("approval", "waiting_permission"),
      row("running", "running"), row("failed", "failed"), row("done", "completed")];
    vi.spyOn(agentRuntimeApi, "listSessionBadges").mockResolvedValue({ items });
    const projectIds = ["current", "workspace"];
    const view = renderHook(({ current }) => useProjectSessionBadges(projectIds, current), {
      initialProps: { current: "current" },
    });
    await waitFor(() => expect(view.result.current.badges.workspace.total).toBe(5));

    view.rerender({ current: "workspace" });
    expect(view.result.current.badges.workspace.total).toBe(0);
    expect(markerState.active.readSessionMarkers).toEqual({});
    expect(markerState.saved).toEqual({});
    await act(() => view.result.current.refresh());
    expect(view.result.current.badges.workspace.total).toBe(0);

    view.rerender({ current: "current" });
    expect(view.result.current.badges.workspace.total).toBe(0);
    view.unmount();

    const restored = renderHook(() => useProjectSessionBadges(projectIds, "current"));
    await act(() => restored.result.current.refresh());
    expect(restored.result.current.badges.workspace.total).toBe(0);
  });

  it("acknowledges activity while viewing a workspace and counts new activity after leaving", async () => {
    const request = vi.spyOn(agentRuntimeApi, "listSessionBadges").mockResolvedValue({ items: [
      row("done", "completed"), { ...row("elsewhere", "failed"), projectId: "third" },
    ] });
    const view = renderHook(({ current }) => useProjectSessionBadges(["current", "workspace", "third"], current), {
      initialProps: { current: "workspace" },
    });
    await waitFor(() => expect(view.result.current.badges.third.total).toBe(1));
    expect(view.result.current.badges.workspace.total).toBe(0);

    vi.mocked(Date.now).mockReturnValue(now + 2000);
    request.mockResolvedValue({ items: [
      { ...row("done", "completed"), updatedAt: new Date(now + 1000).toISOString() },
      { ...row("elsewhere", "failed"), projectId: "third" },
    ] });
    await act(() => view.result.current.refresh());
    view.rerender({ current: "current" });
    expect(view.result.current.badges.workspace.total).toBe(0);
    expect(view.result.current.badges.third.total).toBe(1);

    vi.mocked(Date.now).mockReturnValue(now + 4000);
    request.mockResolvedValue({ items: [
      { ...row("done", "completed"), updatedAt: new Date(now + 3000).toISOString() },
    ] });
    await act(() => view.result.current.refresh());
    expect(view.result.current.badges.workspace.unreadCompleted).toBe(1);
    view.rerender({ current: "workspace" });
    expect(view.result.current.badges.workspace.total).toBe(0);
  });

  it("does not restore old badges when an in-flight snapshot arrives after a workspace visit", async () => {
    let resolve!: (value: { items: SessionBadgeRow[] }) => void;
    vi.spyOn(agentRuntimeApi, "listSessionBadges").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = renderHook(({ current }) => useProjectSessionBadges(["current", "workspace"], current), {
      initialProps: { current: "current" },
    });
    view.rerender({ current: "workspace" });
    view.rerender({ current: "current" });
    await act(async () => resolve({ items: [row("done", "completed"), row("running", "running")] }));
    expect(view.result.current.badges.workspace.total).toBe(0);
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
