import { describe, expect, it, vi } from "vitest";
import { t } from "../../../../lib/i18n";
import { absoluteWorkspacePath, fileContextEntries, sourceContextEntries } from "../workspaceContextMenus";

const zh = (key: Parameters<typeof t>[1]) => t("zh", key);
const ids = (entries: ReturnType<typeof fileContextEntries>) => entries.filter((e) => e.type === "action").map((e) => e.id);

describe("workspace context actions", () => {
  it("distinguishes a deleted Git file from an available file", () => {
    const args = { t: zh, path: "a.ts", workspacePath: "/repo", onDiff: vi.fn(), onOpen: vi.fn(), onRevert: vi.fn(), canRevert: true };
    expect(ids(fileContextEntries({ ...args, canOpenFile: false }))).toEqual(["diff", "copy-relative", "copy-absolute", "revert"]);
    expect(ids(fileContextEntries(args))).toContain("open");
  });
  it("does not reveal or copy a local path for search sources", () => {
    expect(ids(sourceContextEntries({ t: zh, label: "search results", onOpen: vi.fn() }))).toEqual(["open", "copy-source"]);
  });
  it("joins absolute paths with their workspace's separator", () => {
    expect(absoluteWorkspacePath("/one/root", "src/file.ts")).toBe("/one/root/src/file.ts");
    expect(absoluteWorkspacePath("C:\\repo", "src/file.ts")).toBe("C:\\repo\\src\\file.ts");
  });
});
