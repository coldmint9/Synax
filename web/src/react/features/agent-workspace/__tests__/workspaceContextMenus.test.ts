import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { useShellStore } from "../../../state/shellStore";
import { configApi } from "../../../../lib/api/config";
import { fileMutationBlockReason } from "../fileContextMutations";
import { t } from "../../../../lib/i18n";
import { absoluteWorkspacePath, fileContextEntries, sourceContextEntries } from "../workspaceContextMenus";

const zh = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t("zh", key, vars);
const en = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t("en", key, vars);
const ids = (entries: ReturnType<typeof fileContextEntries>) => entries.filter((e) => e.type === "action").map((e) => e.id);

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, editor: "system", locale: "zh" },
  }));
});
afterEach(() => { Reflect.deleteProperty(window, "electronAPI"); vi.restoreAllMocks(); });

describe("workspace context actions", () => {
  it("distinguishes a deleted Git file from an available file", () => {
    const args = { t: zh, path: "a.ts", workspacePath: "/repo", onDiff: vi.fn(), onOpen: vi.fn(), onRevert: vi.fn(), canRevert: true };
    expect(ids(fileContextEntries({ ...args, canOpenFile: false }))).toEqual(["diff", "copy-relative", "copy-absolute", "revert"]);
    expect(ids(fileContextEntries(args))).toContain("open");
  });
  it("exposes file operations but only offers native file clipboard on desktop", () => {
    const args = { t: zh, path: "a.ts", workspacePath: "/repo", sessionId: "session-1", rootId: "root-1", onOpen: vi.fn() };
    expect(ids(fileContextEntries(args))).toEqual(["open", "open-configured", "copy-relative", "copy-absolute", "open-terminal", "rename", "trash"]);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { copyWorkspaceFile: vi.fn() } });
    expect(ids(fileContextEntries(args))).toContain("copy-file");
    expect(ids(fileContextEntries({ ...args, canOpenFile: false }))).toEqual(["copy-relative", "copy-absolute"]);
  });
  it("reflects the selected Settings file opener and opens the absolute path with it", async () => {
    const open = vi.spyOn(configApi, "openFile").mockResolvedValue();
    const menu = () => fileContextEntries({ t: zh, path: "src/a.ts", workspacePath: "/repo", onOpen: vi.fn() });
    const entry = () => menu().find((item) => item.type === "action" && item.id === "open-configured");

    expect(entry()).toMatchObject({ label: "用系统默认应用打开" });
    useShellStore.setState((state) => ({ preferences: { ...state.preferences, editor: "cursor" } }));
    const cursor = entry();
    expect(cursor).toMatchObject({ label: "用Cursor打开" });
    if (cursor?.type !== "action") throw new Error("Configured opener is missing");
    await cursor.run();
    expect(open).toHaveBeenCalledExactlyOnceWith("/repo/src/a.ts");

    useShellStore.setState((state) => ({ preferences: { ...state.preferences, editor: "vscode" } }));
    expect(entry()).toMatchObject({ label: "用VS Code打开" });
    expect(fileContextEntries({ t: en, path: "src/a.ts", workspacePath: "/repo" })
      .find((item) => item.type === "action" && item.id === "open-configured"))
      .toMatchObject({ label: "Open with VS Code" });
    useShellStore.setState((state) => ({ preferences: { ...state.preferences, editor: "missing-app" } }));
    expect(entry()).toMatchObject({ label: "用missing-app打开" });
    expect(fileContextEntries({ t: zh, path: "removed.ts", workspacePath: "/repo", canOpenFile: false })
      .some((item) => item.type === "action" && item.id === "open-configured")).toBe(false);
  });

  it("blocks destructive actions for a running agent or unsaved editor", () => {
    const args = { t: zh, path: "a.ts", workspacePath: "/repo", sessionId: "session-1", rootId: "root-1" };
    useAgentSessionStore.setState({ sessions: [{ id: "session-1", status: "running" }] as ReturnType<typeof useAgentSessionStore.getState>["sessions"] });
    const running = fileContextEntries(args).filter((entry) => entry.type === "action" && ["rename", "trash"].includes(entry.id));
    expect(running.every((entry) => entry.type === "action" && entry.disabled && entry.label.includes("会话正在运行"))).toBe(true);
    useAgentSessionStore.setState({ sessions: [
      { id: "session-1", status: "completed" },
      { id: "child-1", parentSessionId: "session-1", status: "running" },
    ] as ReturnType<typeof useAgentSessionStore.getState>["sessions"] });
    expect(fileMutationBlockReason("session-1", "root-1", "a.ts")).toBe("running");
    useAgentSessionStore.setState({ sessions: [{ id: "session-1", status: "completed" }] as ReturnType<typeof useAgentSessionStore.getState>["sessions"] });
    useSessionWorkspaceStore.setState({ sessions: { "session-1": {
      tabs: [{ id: "file:root-1:a.ts", kind: "file", title: "a.ts", path: "a.ts", rootId: "root-1", dirty: true }],
      activeTabId: "file:root-1:a.ts", presentation: "dock",
    } } });
    expect(fileMutationBlockReason("session-1", "root-1", "a.ts")).toBe("unsaved");
    expect(fileMutationBlockReason("session-1", "other-root", "a.ts")).toBeNull();
    useSessionWorkspaceStore.setState({ sessions: { "session-2": useSessionWorkspaceStore.getState().sessions["session-1"] } });
    expect(fileMutationBlockReason("session-1", "root-1", "a.ts")).toBe("unsaved");
    const unsaved = fileContextEntries(args).filter((entry) => entry.type === "action" && ["rename", "trash"].includes(entry.id));
    expect(unsaved.every((entry) => entry.type === "action" && entry.disabled && entry.label.includes("未保存修改"))).toBe(true);
  });
  it("does not reveal or copy a local path for search sources", () => {
    expect(ids(sourceContextEntries({ t: zh, label: "search results", onOpen: vi.fn() }))).toEqual(["open", "copy-source"]);
  });
  it("joins absolute paths with their workspace's separator", () => {
    expect(absoluteWorkspacePath("/one/root", "src/file.ts")).toBe("/one/root/src/file.ts");
    expect(absoluteWorkspacePath("C:\\repo", "src/file.ts")).toBe("C:\\repo\\src\\file.ts");
  });
});
