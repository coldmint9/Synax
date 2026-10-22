import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grepSearchTool } from "../tools/grep-search.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";
import * as ripgrep from "../tools/ripgrep.js";

const roots: string[] = [];
const sessionId = "grep-fallback-test";

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionWorkspaceRoot(sessionId);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("rg fallback", () => {
  it("prunes ignored dependencies, nested ignore rules and symlinks before searching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-bounded-search-")); roots.push(root);
    fs.mkdirSync(path.join(root, "node_modules")); fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n*.log\n");
    fs.writeFileSync(path.join(root, "node_modules", "huge.ts"), "needle\n");
    fs.writeFileSync(path.join(root, "src", ".gitignore"), "skip.ts\n!keep.log\n");
    fs.writeFileSync(path.join(root, "src", "skip.ts"), "needle\n");
    fs.writeFileSync(path.join(root, "src", "keep.log"), "needle\n");
    fs.symlinkSync(root, path.join(root, "loop"), "dir");
    setSessionWorkspaceRoot(sessionId, root); vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue(null);
    const result = await grepSearchTool.execute({ sessionId, args: { query: "needle" } } as never);
    expect(result.result).toMatchObject({ status: "complete", partial: false, scannedFiles: 1, hits: [{ path: "src/keep.log" }] });
  });

  it("reports bounded partial results instead of claiming a complete search", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-bounded-search-")); roots.push(root);
    fs.writeFileSync(path.join(root, "one.ts"), "needle\n".repeat(1000));
    setSessionWorkspaceRoot(sessionId, root); vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue(null);
    const result = await grepSearchTool.execute({ sessionId, args: { query: "needle", limit: 2 } } as never);
    expect(result.result).toMatchObject({ status: "limit_reached", partial: true });
    expect((result.result as { hits: unknown[] }).hits).toHaveLength(2);
  });

  it("does not start a search after cancellation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-bounded-search-")); roots.push(root);
    setSessionWorkspaceRoot(sessionId, root);
    const probe = vi.spyOn(ripgrep, "resolveRipgrep");
    const result = await grepSearchTool.execute({ sessionId, abortSignal: AbortSignal.abort(), args: { query: "needle" } } as never);
    expect(result.result).toMatchObject({ status: "cancelled", partial: true, hits: [] });
    expect(probe).not.toHaveBeenCalled();
  });
  it("uses grep when bundled ripgrep cannot start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-grep-fallback-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "one.ts"), "before\nneedle here\nafter\n");
    fs.writeFileSync(
      path.join(root, "two.txt"),
      "needle in excluded extension\n",
    );
    setSessionWorkspaceRoot(sessionId, root);
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue(null);

    const result = await grepSearchTool.execute({
      args: {
        query: "needle",
        filePattern: "*.ts",
        contextLines: 1,
      },
      sessionId,
    } as never);

    expect(result.result).toMatchObject({
      query: "needle",
      hits: [
        {
          path: "one.ts",
          line: 2,
          preview: "needle here",
          contextBefore: ["before"],
          contextAfter: ["after"],
        },
      ],
    });
    expect(result.displaySummary).toContain("grep fallback");
  });
});
