import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireWorkspaceDraftLease,
  getWorkspaceDraft,
  registerWorkspaceSaveHandler,
  saveWorkspaceTab,
  setWorkspaceDraft,
  useSessionWorkspaceStore,
  workspaceResourceCounts,
} from "../sessionWorkspaceStore";
beforeEach(() => {
  useSessionWorkspaceStore.getState().removeSessions(["a", "b"]);
});
describe("workspace drafts and saved handlers", () => {
  it("scopes identical tab ids by the owning session", async () => {
    const one = acquireWorkspaceDraftLease("a", "file:app.ts"),
      two = acquireWorkspaceDraftLease("b", "file:app.ts");
    setWorkspaceDraft("a", "file:app.ts", "A", one);
    setWorkspaceDraft("b", "file:app.ts", "B", two);
    const saveA = vi.fn(async () => true),
      saveB = vi.fn(async () => true);
    registerWorkspaceSaveHandler("a", "file:app.ts", saveA, one);
    registerWorkspaceSaveHandler("b", "file:app.ts", saveB, two);
    expect(getWorkspaceDraft("a", "file:app.ts")).toBe("A");
    expect(getWorkspaceDraft("b", "file:app.ts")).toBe("B");
    await saveWorkspaceTab("a", "file:app.ts");
    expect(saveA).toHaveBeenCalledOnce();
    expect(saveB).not.toHaveBeenCalled();
  });
  it("retiring a closed tab rejects late model flushes and does not retain tombstones", async () => {
    const baseline = workspaceResourceCounts();
    const lease = acquireWorkspaceDraftLease("a", "file:app.ts");
    setWorkspaceDraft("a", "file:app.ts", "old", lease);
    const save = vi.fn(async () => true);
    registerWorkspaceSaveHandler("a", "file:app.ts", save, lease);
    useSessionWorkspaceStore.getState().closeTab("a", "file:app.ts");
    setWorkspaceDraft("a", "file:app.ts", "late destructor flush", lease);
    registerWorkspaceSaveHandler("a", "file:app.ts", save, lease);
    expect(getWorkspaceDraft("a", "file:app.ts")).toBeUndefined();
    expect(await saveWorkspaceTab("a", "file:app.ts")).toBe(false);
    expect(workspaceResourceCounts()).toEqual(baseline);
    const reopened = acquireWorkspaceDraftLease("a", "file:app.ts");
    setWorkspaceDraft("a", "file:app.ts", "new", reopened);
    setWorkspaceDraft("a", "file:app.ts", "late old save", lease);
    expect(getWorkspaceDraft("a", "file:app.ts")).toBe("new");
  });
  it.each(["closeAll", "resetSession"] as const)(
    "cleans every resource through %s",
    (operation) => {
      const baseline = workspaceResourceCounts();
      const lease = acquireWorkspaceDraftLease("a", "file:a.ts");
      setWorkspaceDraft("a", "file:a.ts", "draft", lease);
      acquireWorkspaceDraftLease("a", "file:b.ts");
      useSessionWorkspaceStore.getState()[operation]("a");
      setWorkspaceDraft("a", "file:a.ts", "after close", lease);
      expect(workspaceResourceCounts()).toEqual(baseline);
    },
  );
  it("closeOthers retains only the surviving draft and handler", () => {
    const one = acquireWorkspaceDraftLease("a", "file:one"),
      two = acquireWorkspaceDraftLease("a", "file:two");
    setWorkspaceDraft("a", "file:one", "one", one);
    setWorkspaceDraft("a", "file:two", "two", two);
    useSessionWorkspaceStore.getState().closeOthers("a", "file:one");
    setWorkspaceDraft("a", "file:two", "late", two);
    expect(getWorkspaceDraft("a", "file:one")).toBe("one");
    expect(getWorkspaceDraft("a", "file:two")).toBeUndefined();
  });
});
