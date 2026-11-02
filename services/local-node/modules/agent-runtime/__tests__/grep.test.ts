import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grepSearchTool } from "../tools/grep-search.js";
import * as execAsync from "../tools/exec-async.js";
import * as ripgrep from "../tools/ripgrep.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";

const sessionId = "grep-preview-truncation-test";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionWorkspaceRoot(sessionId);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function longLine(prefix: string): string {
  return prefix + "x".repeat(300 - prefix.length);
}

function makeWorkspace(fileName: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-grep-preview-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, fileName), "before-" + "b".repeat(300) + "\n" + longLine("needle-") + "\n" + "after-" + "a".repeat(300) + "\n");
  setSessionWorkspaceRoot(sessionId, root);
  return root;
}

function resultFor(args: Record<string, unknown>) {
  return grepSearchTool.execute({ sessionId, args } as never);
}

interface Hit {
  preview: string;
  previewMetadata: Record<string, unknown>;
  contextBefore?: string[];
  contextBeforeMetadata?: Array<Record<string, unknown>>;
  contextAfter?: string[];
  contextAfterMetadata?: Array<Record<string, unknown>>;
}

describe("search preview truncation evidence", () => {
  it("marks every truncated native rg match and context line without changing legacy strings", async () => {
    makeWorkspace("long.ts");
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue("/fake/rg");
    vi.spyOn(execAsync, "runCommand").mockResolvedValue({
      status: 0,
      stdout: [
        JSON.stringify({ type: "context", data: { lines: { text: "before-" + "b".repeat(300) + "\n" } } }),
        JSON.stringify({ type: "match", data: { path: { text: "long.ts" }, line_number: 2, lines: { text: longLine("needle-") + "\n" } } }),
        JSON.stringify({ type: "context", data: { lines: { text: "after-" + "a".repeat(300) + "\n" } } }),
        JSON.stringify({ type: "end", data: {} }),
      ].join("\n"),
      stderr: "",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    });

    const result = await resultFor({ query: "needle", contextLines: 1 });
    const hit = (result.result as { hits: Hit[] }).hits[0]!;
    expect(hit.preview).toBe(longLine("needle-").slice(0, 240));
    expect(hit.previewMetadata).toEqual({ truncated: true, originalLength: 300 });
    expect(hit.contextBefore).toEqual([("before-" + "b".repeat(300)).slice(0, 240)]);
    expect(hit.contextAfter).toEqual([("after-" + "a".repeat(300)).slice(0, 240)]);
    expect(hit.contextBeforeMetadata?.[0]).toMatchObject({ originalLength: 307, truncated: true });
    expect(hit.contextAfterMetadata?.[0]).toMatchObject({ originalLength: 306, truncated: true });
  });

  it("marks truncation in the grep fallback that enumerates files with Node", async () => {
    makeWorkspace("long.txt");
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue(null);

    const result = await resultFor({ query: "needle", contextLines: 1 });
    const hit = (result.result as { hits: Hit[] }).hits[0]!;
    expect(hit.preview).toBe(longLine("needle-").slice(0, 240));
    expect(hit.previewMetadata).toMatchObject({ truncated: true, originalLength: 300 });
  });
});
