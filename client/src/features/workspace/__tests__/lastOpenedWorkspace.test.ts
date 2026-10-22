import { afterEach, describe, expect, it } from "vitest";
import {
  clearLastOpenedWorkspaceId,
  loadLastOpenedWorkspaceId,
  resolveStartupWorkspaceId,
  saveLastOpenedWorkspaceId,
} from "../lastOpenedWorkspace";

describe("lastOpenedWorkspace", () => {
  afterEach(() => {
    clearLastOpenedWorkspaceId();
  });

  it("remembers the workspace the user closed", () => {
    expect(loadLastOpenedWorkspaceId()).toBeNull();
    saveLastOpenedWorkspaceId("ws-last");
    expect(loadLastOpenedWorkspaceId()).toBe("ws-last");
  });

  it("ignores an empty workspace id", () => {
    saveLastOpenedWorkspaceId("");
    expect(loadLastOpenedWorkspaceId()).toBeNull();
  });

  it("only clears the workspace it is asked to forget", () => {
    saveLastOpenedWorkspaceId("ws-kept");
    clearLastOpenedWorkspaceId("ws-other");
    expect(loadLastOpenedWorkspaceId()).toBe("ws-kept");
    clearLastOpenedWorkspaceId("ws-kept");
    expect(loadLastOpenedWorkspaceId()).toBeNull();
  });

  it("resumes the remembered workspace even when another one was updated later", () => {
    const projects = [
      { id: "ws-other", updatedAt: "2026-10-22T09:00:00.000Z" },
      { id: "ws-remembered", updatedAt: "2026-10-20T09:00:00.000Z" },
    ];
    expect(resolveStartupWorkspaceId(projects, "ws-remembered")).toBe(
      "ws-remembered",
    );
  });

  it("falls back to the most recently updated workspace when the remembered one is gone", () => {
    const projects = [
      { id: "ws-old", updatedAt: "2026-10-01T09:00:00.000Z" },
      { id: "ws-new", updatedAt: "2026-10-22T09:00:00.000Z" },
      { id: "ws-mid", updatedAt: "2026-10-10T09:00:00.000Z" },
    ];
    expect(resolveStartupWorkspaceId(projects, "ws-deleted")).toBe("ws-new");
    expect(resolveStartupWorkspaceId(projects, null)).toBe("ws-new");
  });

  it("returns nothing when no workspace is available", () => {
    expect(resolveStartupWorkspaceId([], "ws-remembered")).toBeNull();
  });

  it("tolerates unknown update timestamps", () => {
    const projects = [
      { id: "ws-broken", updatedAt: "not-a-date" },
      { id: "ws-just-now", updatedAt: "just now" },
    ];
    expect(resolveStartupWorkspaceId(projects, null)).toBe("ws-just-now");
  });
});
