import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeTemplate, parseContextMenu, resolveRevealTarget, textContextTemplate } from "./context-menu.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe("native context menu boundary", () => {
  const valid = { requestId: "request-1", x: 14, y: 20, entries: [
    { type: "action", id: "open", label: "Open" },
    { type: "separator" },
    { type: "action", id: "remove", label: "Delete", danger: true, disabled: true },
  ] };
  it("validates descriptions and dispatches only an action identifier", () => {
    const parsed = parseContextMenu(valid)!;
    expect(parsed.entries).toHaveLength(3);
    const onAction = vi.fn();
    const items = nativeTemplate(parsed.entries, onAction);
    expect(items[2]).toMatchObject({ id: "remove", enabled: false });
    (items[0].click as Function)();
    expect(onAction).toHaveBeenCalledExactlyOnceWith("open");
    expect(parseContextMenu({ ...valid, entries: [{ ...valid.entries[0], id: "open; rm -rf" }] })).toBeNull();
    expect(parseContextMenu({ ...valid, entries: [valid.entries[0], valid.entries[0]] })).toBeNull();
    expect(parseContextMenu({ ...valid, entries: [{ type: "action", id: "open", label: "Bad\nmenu" }] })).toBeNull();
  });
  it("keeps native editor menus separate from business menus", () => {
    expect(textContextTemplate(false, false)).toBeNull();
    expect(textContextTemplate(false, true)?.map((item) => item.role)).toEqual(["copy"]);
    expect(textContextTemplate(true, false)?.map((item) => item.role)).toContain("paste");
  });
  it("accepts only existing files inside the canonical workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-context-menu-")); dirs.push(root);
    fs.mkdirSync(path.join(root, "repo"));
    fs.writeFileSync(path.join(root, "repo", "file.ts"), "ok");
    fs.writeFileSync(path.join(root, "outside.ts"), "outside");
    const base = { workspacePath: path.join(root, "repo") };
    expect(resolveRevealTarget({ ...base, relativePath: "file.ts" })).toBe(fs.realpathSync(path.join(root, "repo", "file.ts")));
    expect(resolveRevealTarget({ ...base, relativePath: "../outside.ts" })).toBeNull();
    expect(resolveRevealTarget({ ...base, relativePath: "missing.ts" })).toBeNull();
    fs.symlinkSync(path.join(root, "outside.ts"), path.join(root, "repo", "link.ts"));
    expect(resolveRevealTarget({ ...base, relativePath: "link.ts" })).toBeNull();
  });
});
