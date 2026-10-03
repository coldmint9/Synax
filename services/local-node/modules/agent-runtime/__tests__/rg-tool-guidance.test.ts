import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rgTool } from "../tools/rg.js";
import { grepSearchTool } from "../tools/grep-search.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";
import * as execAsync from "../tools/exec-async.js";
import * as ripgrep from "../tools/ripgrep.js";

const sessionId = "rg-tool-guidance-test";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionWorkspaceRoot(sessionId);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-rg-guidance-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  setSessionWorkspaceRoot(sessionId, root);
  return root;
}

function stubRunCommand(status: number, stderr = "") {
  return vi.spyOn(execAsync, "runCommand").mockResolvedValue({
    status,
    stdout: "",
    stderr,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
}

describe("rg tool guidance", () => {
  it("documents the fixed-string default", () => {
    expect(rgTool.description).toMatch(/fixed-string unless regex=true/i);
    expect(grepSearchTool.description).toMatch(/fixed-string by default/i);
  });

  it("documents the leading-dash pitfall", () => {
    expect(rgTool.progressiveDetails).toMatch(/never begin query or pattern with "-"/);
    expect(rgTool.progressiveDetails).toMatch(/leading dash/);
  });

  it("ships argument examples", () => {
    const details = rgTool.progressiveDetails ?? "";
    expect(details).toContain("Examples:");
    expect(details).toContain('"mode": "files"');
    expect(details).toMatch(/"regex": true/);
  });
});

describe("rg tool query guard", () => {
  it("passes a dash-prefixed query behind -- so ripgrep does not read it as a flag", async () => {
    makeWorkspace({ "theme.css": ":root {\n  --color-border: var(--border);\n}\n" });
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue("/fake/ripgrep");
    const runCommand = stubRunCommand(1);

    await grepSearchTool.execute({
      args: { query: "--color-border" },
      sessionId,
    } as never);

    const argv = runCommand.mock.calls[0]?.[1] as string[];
    expect(argv.slice(-3)).toEqual(["--", "--color-border", "."]);
  });

  it("blames a leading dash instead of the bundled ripgrep", async () => {
    makeWorkspace({ "theme.css": ":root {}\n" });
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue("/fake/ripgrep");
    stubRunCommand(2, "rg: unrecognized flag --color|--bg|theme token|:root\n");

    await expect(
      grepSearchTool.execute({
        args: { query: "--color|--bg|theme token|:root" },
        sessionId,
      } as never),
    ).rejects.toThrow(/begins with "-"/);
  });

  it("searches a dash-prefixed query with the real bundled ripgrep", async () => {
    const rgPath = await ripgrep.resolveRipgrepBinary();
    if (!rgPath) return; // Bundled ripgrep unavailable on this host.

    makeWorkspace({
      "theme.css": ":root {\n  --color-border: var(--border);\n}\n",
    });

    const result = await grepSearchTool.execute({
      args: { query: "--color-border", filePattern: "*.css" },
      sessionId,
    } as never);

    expect(result.result).toMatchObject({
      hits: [{ path: "theme.css", line: 2 }],
    });
  });
});
