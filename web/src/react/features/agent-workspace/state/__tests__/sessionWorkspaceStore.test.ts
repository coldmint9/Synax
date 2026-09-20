import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_SESSION_WORKSPACE,
  openWorkspaceTab,
  useSessionWorkspaceStore,
} from "../sessionWorkspaceStore";

describe("sessionWorkspaceStore", () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} });
  });

  it("keeps tabs isolated per session and restores the prior active tab", () => {
    const store = useSessionWorkspaceStore.getState();
    store.openTab("session-a", { kind: "diff", title: "a.ts", path: "a.ts" });
    store.openTab("session-b", { kind: "file", title: "b.ts", path: "b.ts" });
    store.activateTab("session-a", "diff:a.ts");
    store.enterFocus("session-b");

    const state = useSessionWorkspaceStore.getState().sessions;
    expect(state["session-a"].activeTabId).toBe("diff:a.ts");
    expect(state["session-a"].presentation).toBe("dock");
    expect(state["session-b"].activeTabId).toBe("file:b.ts");
    expect(state["session-b"].presentation).toBe("focus");
  });

  it("opens tabs without leaving dock presentation", () => {
    openWorkspaceTab("session-a", {
      kind: "diff",
      title: "a.ts",
      path: "a.ts",
    });
    expect(
      useSessionWorkspaceStore.getState().sessions["session-a"].presentation,
    ).toBe("dock");
  });

  it("leaves fullscreen when the last tab closes", () => {
    const store = useSessionWorkspaceStore.getState();
    store.openTab("session-a", { kind: "file", title: "a.ts", path: "a.ts" });
    store.enterFocus("session-a");
    store.closeAll("session-a");

    expect(
      useSessionWorkspaceStore.getState().sessions["session-a"],
    ).toMatchObject({
      tabs: [],
      activeTabId: null,
      presentation: "dock",
    });
  });

  it("removes only the deleted sessions", () => {
    const store = useSessionWorkspaceStore.getState();
    store.openTab("keep", { kind: "file", title: "keep.ts", path: "keep.ts" });
    store.openTab("delete", {
      kind: "file",
      title: "delete.ts",
      path: "delete.ts",
    });
    store.removeSessions(["delete"]);

    expect(useSessionWorkspaceStore.getState().sessions.keep).toBeDefined();
    expect(useSessionWorkspaceStore.getState().sessions.delete).toBeUndefined();
    expect(EMPTY_SESSION_WORKSPACE.tabs).toEqual([]);
  });

  it("closes destroyed subagent tabs in surviving parents without closing unrelated tabs", () => {
    const store = useSessionWorkspaceStore.getState();
    store.openTab("parent", {
      kind: "file",
      path: "keep.ts",
      title: "keep.ts",
    });
    store.openTab("parent", {
      kind: "subagent",
      sessionId: "child",
      title: "Child",
    });
    store.enterFocus("parent");
    store.openTab("other", {
      kind: "subagent",
      sessionId: "sibling",
      title: "Sibling",
    });
    store.removeSessions(["child"]);
    expect(useSessionWorkspaceStore.getState().sessions.parent).toMatchObject({
      tabs: [{ kind: "file", path: "keep.ts" }],
      activeTabId: null,
      presentation: "dock",
    });
    expect(
      useSessionWorkspaceStore.getState().sessions.other.tabs,
    ).toHaveLength(1);
  });
});
