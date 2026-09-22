import { describe, expect, it } from "vitest";
import { openerCommand } from "../index.js";

const app = (
  id: string,
  kind: "editor" | "finder" | "terminal" = "editor",
) => ({
  id,
  name: id,
  icon: null,
  appPath: `/Applications/${id}.app`,
  cli: kind === "editor" ? `/Applications/${id}.app/bin/editor` : undefined,
  kind,
});
describe("file opening destinations", () => {
  it("uses the OS association, not the first editor CLI, for system default", () => {
    expect(openerCommand("/repo/a.ts", 12, undefined, "darwin")).toEqual({
      bin: "/usr/bin/open",
      args: ["/repo/a.ts"],
    });
    expect(openerCommand("/repo", undefined, undefined, "linux").bin).toBe(
      "xdg-open",
    );
    expect(openerCommand("C:\\repo", undefined, undefined, "win32").bin).toBe(
      "explorer.exe",
    );
  });
  it.each(["vscode", "cursor", "windsurf"])(
    "preserves line navigation in %s",
    (id) => {
      expect(
        openerCommand("/repo/file name.ts", 42, app(id), "darwin").args,
      ).toEqual(["--goto", "/repo/file name.ts:42"]);
    },
  );
  it("supports Zed and JetBrains line syntax without a shell", () => {
    expect(openerCommand("/repo/a.ts", 9, app("zed"), "darwin").args).toEqual([
      "/repo/a.ts:9",
    ]);
    expect(openerCommand("/repo/a.ts", 9, app("idea"), "darwin").args).toEqual([
      "-na",
      "/Applications/idea.app",
      "--args",
      "--line",
      "9",
      "/repo/a.ts",
    ]);
  });
  it("opens directories without editor line flags", () => {
    expect(
      openerCommand("/repo", 9, app("vscode"), "darwin", true).args,
    ).toEqual(["/repo"]);
  });
  it("reveals files in Finder and opens folders directly", () => {
    expect(
      openerCommand("/repo/a.ts", undefined, app("finder", "finder"), "darwin")
        .args,
    ).toEqual(["-R", "/repo/a.ts"]);
    expect(
      openerCommand("/repo", undefined, app("finder", "finder"), "darwin", true)
        .args,
    ).toEqual(["-a", "/Applications/finder.app", "/repo"]);
  });
  it("opens Terminal in the parent directory for files", () => {
    expect(
      openerCommand(
        "/repo/a.ts",
        undefined,
        app("terminal", "terminal"),
        "darwin",
      ).args,
    ).toEqual(["-a", "/Applications/terminal.app", "/repo"]);
  });
  it("keeps special characters in an argument instead of executing shell text", () => {
    expect(
      openerCommand(
        "/repo/a;$(touch BAD).ts",
        undefined,
        app("vscode"),
        "darwin",
      ).args,
    ).toEqual(["/repo/a;$(touch BAD).ts"]);
  });
});
