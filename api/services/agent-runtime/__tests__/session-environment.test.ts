import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listToolCalls: vi.fn(),
  listMessages: vi.fn(),
  getToolCall: vi.fn(),
  resolveSessionWorkspaceRoots: vi.fn(),
}));

vi.mock("../session-store.js", () => ({ agentRuntimeStore: mocks }));
vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkspaceRoots: mocks.resolveSessionWorkspaceRoots,
}));
vi.mock("../media-assets.js", () => ({
  detectMediaType: () => "application/octet-stream",
  getAsset: (id: string) => {
    if (id === "asset_" + "a".repeat(32))
      return {
        id,
        projectId: "project",
        filename: "设计稿.png",
        mediaType: "image/png",
        size: 1,
        sha256: "x",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    throw new Error("MEDIA_NOT_FOUND");
  },
}));

import {
  getSessionEnvironment,
  getSessionInputSourceContent,
  invalidateSessionEnvironment,
} from "../session-environment.js";

const sessionId = "gitignore-environment-test";
let workspace: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function write(file: string, content: string): void {
  const target = path.join(workspace, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "synax-environment-"));
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", "generated/*\n!generated/keep.ts\n*.log\n");
  write("src/main.ts", "before\n");
  write("generated/keep.ts", "before\n");
  write("generated/build.js", "before\n");
  write("generated/deleted.js", "before\n");
  write("generated/缓存.js", "before\n");
  write("generated/with space.js", "before\n");
  write("generated/with\nnewline.js", "before\n");
  git("add", "--force", ".");
  git("commit", "--quiet", "-m", "fixture");
  mocks.getSession.mockReturnValue({
    id: sessionId,
    projectId: "project",
    childSessionIds: [],
  });
  mocks.resolveSessionWorkspaceRoots.mockReturnValue([
    {
      id: "project",
      name: "Project",
      path: fs.realpathSync(workspace),
      role: "primary",
      status: "available",
    },
  ]);
  mocks.listToolCalls.mockReturnValue([]);
  mocks.listMessages.mockReturnValue([]);
  invalidateSessionEnvironment(sessionId);
});

afterEach(() => {
  invalidateSessionEnvironment(sessionId);
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("session environment Git ignore filtering", () => {
  it("lists only workspace file reads and external web reads as input sources", async () => {
    mocks.listToolCalls.mockReturnValue([
      {
        id: "file-read",
        toolId: "claude-code.Read",
        status: "completed",
        mutability: "read",
        inputRef: { nativeTool: { file_path: "src/main.ts" } },
      },
      {
        id: "dir-read",
        toolId: "list",
        status: "completed",
        mutability: "read",
        inputSummary: "List src",
        inputRef: { path: "src" },
      },
      {
        id: "shell-read",
        toolId: "bash",
        status: "completed",
        mutability: "read",
        inputSummary: '{"command":"grep -n \\"function parseStat"}',
        inputRef: { command: 'grep -n "function parseStat' },
      },
      {
        id: "fetch-read",
        toolId: "claude-code.WebFetch",
        status: "completed",
        mutability: "read",
        inputRef: {
          nativeTool: {
            url: "https://example.com/docs",
            prompt: "summarize",
          },
        },
      },
      {
        id: "search-read",
        toolId: "webSearch",
        status: "completed",
        mutability: "read",
        inputSummary: '{"query":"Synax docs"}',
        inputRef: { query: "Synax docs" },
      },
      {
        id: "text-read",
        toolId: "grep.search",
        status: "completed",
        mutability: "read",
        inputSummary: '{"query":"SessionEnvironment"}',
        inputRef: { query: "SessionEnvironment" },
      },
    ]);
    mocks.listMessages.mockReturnValue([
      {
        id: "msg-1",
        sessionId,
        role: "user",
        content: "请看截图",
        contentParts: [
          { type: "text", text: "请看截图" },
          {
            type: "image",
            assetId: "asset_" + "a".repeat(32),
            detail: "auto",
          },
        ],
      },
      {
        id: "msg-2",
        sessionId,
        role: "assistant",
        content: "好的",
        contentParts: [{ type: "text", text: "好的" }],
      },
    ]);
    const env = await getSessionEnvironment(sessionId);
    expect(env.inputSources).toEqual([
      {
        kind: "file",
        label: "src/main.ts",
        path: "src/main.ts",
        toolCallId: "file-read",
      },
      {
        kind: "url",
        label: "https://example.com/docs",
        toolCallId: "fetch-read",
      },
      { kind: "url", label: "Synax docs", toolCallId: "search-read" },
      {
        kind: "attachment",
        label: "设计稿.png",
        assetId: "asset_" + "a".repeat(32),
      },
    ]);
  });

  it("previews recorded output in the owning session and rejects non-read operations", () => {
    mocks.getToolCall.mockReturnValue({
      status: "completed",
      mutability: "read",
      outputRef: { matches: ["src/main.ts"] },
      outputSummary: "one result",
    });
    expect(getSessionInputSourceContent(sessionId, "search-read")).toEqual({
      content: JSON.stringify({ matches: ["src/main.ts"] }, null, 2),
      truncated: false,
    });
    expect(mocks.getToolCall).toHaveBeenCalledWith(sessionId, "search-read");
    mocks.getToolCall.mockReturnValue({
      status: "completed",
      mutability: "read",
      outputRef: null,
      outputSummary: "Recorded command output",
    });
    expect(
      getSessionInputSourceContent(sessionId, "command-read").content,
    ).toBe("Recorded command output");
    mocks.getToolCall.mockReturnValue({
      status: "completed",
      mutability: "read",
      outputRef: "a".repeat(1024 * 1024 + 10),
    });
    const limited = getSessionInputSourceContent(sessionId, "large-read");
    expect(limited.truncated).toBe(true);
    expect(limited.content.length).toBe(1024 * 1024);
    mocks.getToolCall.mockReturnValue({
      status: "completed",
      mutability: "write",
    });
    expect(() => getSessionInputSourceContent(sessionId, "write")).toThrow(
      "Only completed input reads",
    );
  });
  it("excludes ignored tracked and untracked changes from files, line totals and agent attribution", async () => {
    write("src/main.ts", "after\nextra\n");
    write("src/new.ts", "new\n");
    write("generated/keep.ts", "after\n");
    write("generated/build.js", "after\nignored\n");
    write("generated/缓存.js", "after\n");
    write("generated/with space.js", "after\n");
    write("generated/with\nnewline.js", "after\n");
    write("generated/new.js", "ignored\n");
    write("debug.log", "ignored\n");
    write("generated/staged.js", "ignored\n");
    git("add", "--force", "generated/staged.js");
    git("rm", "--quiet", "generated/deleted.js");
    mocks.listToolCalls.mockReturnValue([
      {
        toolId: "edit",
        status: "completed",
        inputRef: { path: "src/main.ts" },
      },
      {
        toolId: "edit",
        status: "completed",
        inputRef: { path: "generated/build.js" },
      },
    ]);

    const environment = await getSessionEnvironment(sessionId);

    expect(environment.changedFiles.map((file) => file.path).sort()).toEqual([
      "generated/keep.ts",
      "src/main.ts",
      "src/new.ts",
    ]);
    expect(environment.additions).toBe(4);
    expect(environment.deletions).toBe(2);
    expect(environment.dirty).toBe(true);
    expect(environment.agentChangedFiles.map((file) => file.path)).toEqual([
      "src/main.ts",
    ]);
  });

  it("reports no changes when only ignored files changed, including nested ignore rules", async () => {
    write("generated/build.js", "ignored change\n");
    write("debug.log", "ignored\n");
    write("src/.gitignore", "cache/\n!keep.log\n");
    git("add", "src/.gitignore");
    git("commit", "--quiet", "-m", "nested rules");
    write("src/cache/tracked.ts", "before\n");
    git("add", "--force", "src/cache/tracked.ts");
    git("commit", "--quiet", "-m", "tracked cache");
    write("src/cache/tracked.ts", "after\n");

    const environment = await getSessionEnvironment(sessionId);

    expect(environment.changedFiles).toEqual([]);
    expect(environment.agentChangedFiles).toEqual([]);
    expect(environment.additions).toBe(0);
    expect(environment.deletions).toBe(0);
    expect(environment.dirty).toBe(false);
  });

  it("preserves ordinary changes when no paths match ignore rules", async () => {
    write("src/main.ts", "after\n");
    git("add", "src/main.ts");
    const environment = await getSessionEnvironment(sessionId);
    expect(environment.changedFiles).toEqual([
      {
        path: "src/main.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        staged: true,
        untracked: false,
      },
    ]);
  });

  it("filters renamed files by destination while retaining visible rename paths and line counts", async () => {
    write("src/main.ts", "one\ntwo\nthree\nfour\nfive\n");
    git("add", "src/main.ts");
    git("commit", "--quiet", "-m", "rename fixture");
    git("mv", "src/main.ts", "src/renamed 文件.ts");
    write("src/renamed 文件.ts", "one\ntwo\nthree\nfour\nfive\nsix\n");
    git("mv", "generated/keep.ts", "generated/ignored.ts");

    const environment = await getSessionEnvironment(sessionId);

    expect(environment.changedFiles).toEqual([
      {
        path: "src/renamed 文件.ts",
        status: "renamed",
        additions: 1,
        deletions: 0,
        staged: true,
        untracked: false,
      },
    ]);
    expect(environment.additions).toBe(1);
    expect(environment.deletions).toBe(0);
  });
});

describe("session output files", () => {
  it("keeps same-name outputs scoped to their repository and excludes directories and escaped symlinks", async () => {
    const reference = fs.mkdtempSync(
      path.join(os.tmpdir(), "synax-output-reference-"),
    );
    try {
      write("result.md", "primary");
      fs.writeFileSync(path.join(reference, "result.md"), "reference");
      fs.mkdirSync(path.join(workspace, "directory-output"));
      fs.symlinkSync(reference, path.join(workspace, "outside-directory"));
      mocks.resolveSessionWorkspaceRoots.mockReturnValue([
        {
          id: "project",
          name: "Project",
          path: fs.realpathSync(workspace),
          role: "primary",
          status: "available",
        },
        {
          id: "reference",
          name: "Reference",
          path: fs.realpathSync(reference),
          role: "reference",
          status: "available",
        },
      ]);
      mocks.listToolCalls.mockReturnValue([
        {
          toolId: "file.write",
          status: "completed",
          inputRef: { path: "result.md" },
        },
        {
          toolId: "file.write",
          status: "completed",
          inputRef: { path: path.join(reference, "result.md") },
        },
        {
          toolId: "file.write",
          status: "completed",
          inputRef: { path: "directory-output" },
        },
        {
          toolId: "file.write",
          status: "completed",
          inputRef: { path: "outside-directory/result.md" },
        },
      ]);
      const environment = await getSessionEnvironment(sessionId);
      expect(environment.outputFiles).toEqual(["result.md"]);
      expect(environment.repositories.map((root) => root.outputFiles)).toEqual([
        ["result.md"],
        ["result.md"],
      ]);
      expect(environment.repositories[1].status).toBe("not_repository");
    } finally {
      fs.rmSync(reference, { recursive: true, force: true });
    }
  });

  it("keeps committed outputs and excludes failed writes, deleted files and other repositories", async () => {
    write("docs/output.md", "# Result\n");
    write("docs/failed.md", "existing content\n");
    git("add", "docs");
    git("commit", "--quiet", "-m", "save output");
    mocks.listToolCalls.mockReturnValue([
      {
        toolId: "file.write",
        status: "completed",
        inputRef: { path: "docs/output.md" },
      },
      {
        toolId: "edit",
        status: "completed",
        inputRef: { path: "docs/output.md" },
      },
      {
        toolId: "file.write",
        status: "failed",
        inputRef: { path: "docs/failed.md" },
      },
      {
        toolId: "file.delete",
        status: "completed",
        inputRef: { path: "docs/deleted.md" },
      },
      {
        toolId: "file.write",
        status: "completed",
        inputRef: { path: "../outside.md" },
      },
    ]);
    const environment = await getSessionEnvironment(sessionId);
    expect(environment.changedFiles).toEqual([]);
    expect(environment.outputFiles).toEqual(["docs/output.md"]);
    expect(environment.repositories[0].outputFiles).toEqual(["docs/output.md"]);
  });

  it("lists outputs from a workspace without a Git repository", async () => {
    fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
    write("result.md", "Result\n");
    mocks.listToolCalls.mockReturnValue([
      {
        toolId: "file.write",
        status: "completed",
        inputRef: { path: "result.md" },
      },
    ]);
    const environment = await getSessionEnvironment(sessionId);
    expect(environment.repositories[0].status).toBe("not_repository");
    expect(environment.outputFiles).toEqual(["result.md"]);
  });
});

it("attributes Codex and Claude file outputs from successful structured tool records", async () => {
  write("docs/codex.md", "codex output");
  write("docs/claude.md", "claude output");
  mocks.listToolCalls.mockReturnValue([
    {
      toolId: "codex.fileChange",
      status: "completed",
      inputRef: {},
      outputRef: [{ path: path.join(workspace, "docs/codex.md") }],
    },
    {
      toolId: "claude-code.Write",
      status: "completed",
      inputRef: {
        nativeTool: { file_path: path.join(workspace, "docs/claude.md") },
        approvalRequest: {},
      },
    },
    {
      toolId: "claude-code.Read",
      status: "completed",
      inputRef: { file_path: "src/main.ts" },
    },
  ]);
  const environment = await getSessionEnvironment(sessionId);
  expect(environment.outputFiles).toEqual(["docs/codex.md", "docs/claude.md"]);
});
