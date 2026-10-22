import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  tryGetSession: vi.fn(),
  listToolCalls: vi.fn(),
  listMessages: vi.fn(),
  getToolCall: vi.fn(),
  resolveSessionWorkspaceRoots: vi.fn(),
  resolveWorkspaceRootsFromSession: vi.fn(),
}));

vi.mock("../session-store.js", () => ({ agentRuntimeStore: mocks }));
vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkspaceRoots: mocks.resolveSessionWorkspaceRoots,
  resolveWorkspaceRootsFromSession: mocks.resolveWorkspaceRootsFromSession,
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
  getSessionEnvironmentInputs,
  getSessionEnvironmentOutputs,
  getSessionEnvironmentRoots,
  getSessionEnvironmentSubagents,
  invalidateAllSessionEnvironmentCards,
} from "../session-environment-cards.js";
import { invalidateSessionEnvironment } from "../session-environment.js";

const sessionId = "session-environment-cards-test";
let workspace: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function write(file: string, content: string): void {
  const target = path.join(workspace, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function primaryRoot() {
  return {
    id: "project",
    name: "Project",
    path: workspace,
    role: "primary" as const,
    status: "available" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAllSessionEnvironmentCards();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "synax-environment-cards-"));
  workspace = fs.realpathSync(workspace);
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  write("src/main.ts", "before\n");
  write("docs/output.md", "# Result\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  mocks.getSession.mockReturnValue({
    id: sessionId,
    projectId: "project",
    childSessionIds: [],
  });
  mocks.tryGetSession.mockReturnValue({
    id: sessionId,
    projectId: "project",
    childSessionIds: [],
  });
  mocks.resolveSessionWorkspaceRoots.mockReturnValue([primaryRoot()]);
  mocks.listToolCalls.mockReturnValue([]);
  mocks.listMessages.mockReturnValue([]);
});

afterEach(() => {
  invalidateAllSessionEnvironmentCards();
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("session roots card", () => {
  it("resolves the workspace binding without reading the transcript", async () => {
    const roots = await getSessionEnvironmentRoots(sessionId);

    expect(roots).toMatchObject({
      sessionId,
      projectId: "project",
      workspacePath: workspace,
      repositories: [
        { rootId: "project", name: "Project", role: "primary", status: "ready", workspacePath: workspace },
      ],
    });
    expect(mocks.listToolCalls).not.toHaveBeenCalled();
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it("caches the card and drops it on invalidation", async () => {
    await getSessionEnvironmentRoots(sessionId);
    await getSessionEnvironmentRoots(sessionId);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);

    invalidateSessionEnvironment(sessionId);
    await getSessionEnvironmentRoots(sessionId);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });
});

describe("session inputs card", () => {
  it("lists only workspace file reads, external web reads and user attachments", async () => {
    mocks.listToolCalls.mockReturnValue([
      {
        id: "file-read",
        toolId: "file.read",
        status: "completed",
        mutability: "read",
        inputRef: { nativeTool: { file_path: "src/main.ts" } },
      },
      {
        id: "dir-read",
        toolId: "list",
        status: "completed",
        mutability: "read",
        inputRef: { path: "src" },
      },
      {
        id: "shell-read",
        toolId: "bash",
        status: "completed",
        mutability: "read",
        inputRef: { command: 'grep -n "function parseStat' },
      },
      {
        id: "fetch-read",
        toolId: "web.fetch",
        status: "completed",
        mutability: "read",
        inputRef: { nativeTool: { url: "https://example.com/docs", prompt: "summarize" } },
      },
      {
        id: "search-read",
        toolId: "webSearch",
        status: "completed",
        mutability: "read",
        inputRef: { query: "Synax docs" },
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
          { type: "image", assetId: "asset_" + "a".repeat(32), detail: "auto" },
        ],
      },
    ]);

    const inputs = await getSessionEnvironmentInputs(sessionId);

    expect(inputs).toMatchObject({ sessionId, projectId: "project", primaryRootId: "project" });
    expect(inputs.byRoot.project).toEqual([
      {
        kind: "file",
        label: "src/main.ts",
        path: "src/main.ts",
        toolCallId: "file-read",
      },
      { kind: "url", label: "https://example.com/docs", toolCallId: "fetch-read" },
      { kind: "url", label: "Synax docs", toolCallId: "search-read" },
      {
        kind: "attachment",
        label: "设计稿.png",
        assetId: "asset_" + "a".repeat(32),
      },
    ]);
  });

  it("builds from runtime records without touching the session store", async () => {
    const calls = [
      { id: "reads", toolId: "file.read", status: "completed", mutability: "read", inputRef: { path: "src/main.ts" } },
    ];
    for (const method of [mocks.getSession, mocks.listToolCalls, mocks.listMessages]) {
      method.mockImplementation(() => {
        throw new Error("SQL disabled");
      });
    }
    mocks.resolveWorkspaceRootsFromSession.mockReturnValue([primaryRoot()]);

    const inputs = await getSessionEnvironmentInputs(sessionId, async () => ({
      session: { id: sessionId, projectId: "project", childSessionIds: [] } as never,
      toolCalls: calls as never[],
      messages: [{ role: "user", contentParts: [{ type: "image", assetId: "rust-asset" }] }] as never[],
      assetNames: new Map([["rust-asset", "from-rocksdb.png"]]),
    }));

    expect(inputs.byRoot.project).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: "src/main.ts", toolCallId: "reads" }),
        expect.objectContaining({ kind: "attachment", label: "from-rocksdb.png" }),
      ]),
    );
    for (const method of [mocks.getSession, mocks.listToolCalls, mocks.listMessages])
      expect(method).not.toHaveBeenCalled();
  });
});

describe("session outputs card", () => {
  it("keeps same-name outputs scoped to their repository and excludes directories and escaped symlinks", async () => {
    const reference = fs.mkdtempSync(path.join(os.tmpdir(), "synax-output-reference-"));
    try {
      write("result.md", "primary");
      fs.writeFileSync(path.join(reference, "result.md"), "reference");
      fs.mkdirSync(path.join(workspace, "directory-output"));
      fs.symlinkSync(reference, path.join(workspace, "outside-directory"));
      mocks.resolveSessionWorkspaceRoots.mockReturnValue([
        primaryRoot(),
        {
          id: "reference",
          name: "Reference",
          path: fs.realpathSync(reference),
          role: "reference" as const,
          status: "available" as const,
        },
      ]);
      mocks.listToolCalls.mockReturnValue([
        { toolId: "file.write", status: "completed", inputRef: { path: "result.md" } },
        { toolId: "file.write", status: "completed", inputRef: { path: path.join(reference, "result.md") } },
        { toolId: "file.write", status: "completed", inputRef: { path: "directory-output" } },
        { toolId: "file.write", status: "completed", inputRef: { path: "outside-directory/result.md" } },
      ]);

      const outputs = await getSessionEnvironmentOutputs(sessionId);

      expect(outputs.byRoot.project).toEqual(["result.md"]);
      expect(outputs.byRoot.reference).toEqual(["result.md"]);
      expect(outputs.editedPathsByRoot.project).toContain("directory-output");
    } finally {
      fs.rmSync(reference, { recursive: true, force: true });
    }
  });

  it("attributes committed outputs and ignores failed writes and escaped paths", async () => {
    write("docs/failed.md", "existing content\n");
    git("add", "docs");
    git("commit", "--quiet", "-m", "save output");
    mocks.listToolCalls.mockReturnValue([
      { toolId: "file.write", status: "completed", inputRef: { path: "docs/output.md" } },
      {
        toolId: "file.patch",
        status: "completed",
        inputRef: { patch: "*** Begin Patch\n*** Update File: docs/output.md\n@@\n-# Result\n+# Result\n*** End Patch" },
      },
      { toolId: "file.write", status: "failed", inputRef: { path: "docs/failed.md" } },
      { toolId: "file.delete", status: "completed", inputRef: { path: "docs/deleted.md" } },
      { toolId: "file.write", status: "completed", inputRef: { path: "../outside.md" } },
    ]);

    const outputs = await getSessionEnvironmentOutputs(sessionId);

    expect(outputs.byRoot.project).toEqual(["docs/output.md"]);
    expect(outputs.editedPathsByRoot.project).toEqual(
      expect.arrayContaining(["docs/output.md", "docs/deleted.md"]),
    );
    expect(outputs.editedPathsByRoot.project).not.toContain("../outside.md");
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
        toolId: "file.write",
        status: "completed",
        inputRef: {
          nativeTool: { file_path: path.join(workspace, "docs/claude.md") },
          approvalRequest: {},
        },
      },
      { toolId: "file.read", status: "completed", inputRef: { file_path: "src/main.ts" } },
    ]);

    const outputs = await getSessionEnvironmentOutputs(sessionId);
    expect(outputs.byRoot.project).toEqual(["docs/codex.md"]);
  });

  it("lists outputs from a workspace without a Git repository", async () => {
    fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
    write("result.md", "Result\n");
    mocks.listToolCalls.mockReturnValue([
      { toolId: "file.write", status: "completed", inputRef: { path: "result.md" } },
    ]);

    const outputs = await getSessionEnvironmentOutputs(sessionId);
    expect(outputs.byRoot.project).toEqual(["result.md"]);
  });
});

describe("session subagents card", () => {
  it("projects child sessions and skips archived or deleted ones", async () => {
    mocks.getSession.mockImplementation((id: string) => {
      if (id === sessionId)
        return { id, projectId: "project", childSessionIds: ["child", "archived", "missing"] };
      if (id === "child")
        return {
          id,
          parentSessionId: sessionId,
          profileId: "explorer",
          status: "running",
          title: "调研",
          prompt: "look around",
          updatedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          resultSummary: null,
          sessionMetadata: { subagentName: "探路" },
        };
      if (id === "archived")
        return {
          id,
          parentSessionId: sessionId,
          profileId: "explorer",
          status: "completed",
          title: null,
          prompt: "",
          updatedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          resultSummary: null,
          sessionMetadata: { archivedAt: "2026-01-02T00:00:00.000Z" },
        };
      throw new Error("not found");
    });

    const subagents = await getSessionEnvironmentSubagents(sessionId);

    expect(subagents.subagents).toHaveLength(1);
    expect(subagents.subagents[0]).toMatchObject({
      id: "child",
      parentSessionId: sessionId,
      subagentName: "探路",
      status: "running",
    });
  });
});
