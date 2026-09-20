import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  root: "",
  members: [] as Array<{ role: string; status: string; path: string }>,
}));
vi.mock("../../../db/index.js", () => ({ getRawSqlite: () => mocks.db }));
vi.mock("../session-store.js", () => ({
  agentRuntimeStore: {
    getSession: () => ({ projectId: "project", permissionRules: [] }),
    tryGetSession: () => null,
  },
}));
vi.mock("../tools/workspace.js", () => ({
  bindSessionWorkDir: () => mocks.root,
  resolveRegisteredProjectWorkDir: () => mocks.root,
  resolveSessionWorkspaceRoots: () => mocks.members,
  resolveProjectWorkspaceLocation: () => ({ kind: "host", path: mocks.root }),
  isWorkspaceEntryVisible: (name: string) => !name.endsWith(".pem"),
  isWorkspaceRelativePathBlocked: (name: string) => name.endsWith(".pem"),
}));
vi.mock("../../skills/skill-registry.js", () => ({ skillRegistry: {} }));
vi.mock("../../skills/agent-bridge.js", () => ({ skillAgentBridge: {} }));
vi.mock("../profile-service.js", () => ({
  profileService: { getForSession: () => ({ id: "synax" }) },
}));
vi.mock("../permission-policy.js", () => ({
  permissionPolicy: { evaluate: () => ({ action: "allow" }) },
}));
vi.mock("../backends/backend-binding.js", () => ({
  resolveSessionBackend: () => ({ id: "native" }),
}));

import {
  listTurnReferenceOptions,
  prepareTurnReferences,
} from "../turn-references.js";
import { workspaceFileIndex } from "../workspace-file-index.js";

let temp: string;
function write(relative: string, content = "text") {
  const full = path.resolve(mocks.root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
function session(id: string, root = mocks.root) {
  mocks.db
    .prepare("INSERT INTO agent_runtime_sessions VALUES (?, ?, ?)")
    .run(id, "project", JSON.stringify({ backend: { workDir: root } }));
}
function read(
  sessionId: string,
  file: string,
  time: string,
  status = "completed",
  tool = "file.read",
  extra?: object,
) {
  mocks.db
    .prepare("INSERT INTO agent_runtime_tool_calls VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      sessionId,
      tool,
      JSON.stringify(extra ?? { path: file }),
      JSON.stringify({ exitCode: 0 }),
      status,
      time,
    );
}
beforeEach(() => {
  temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "synax-context-files-")),
  );
  mocks.root = path.join(temp, "worktree");
  fs.mkdirSync(mocks.root);
  mocks.members = [];
  mocks.db = new Database(":memory:");
  mocks.db.exec(`
    CREATE TABLE agent_runtime_sessions (id TEXT PRIMARY KEY, project_id TEXT, session_metadata_json TEXT);
    CREATE TABLE agent_runtime_tool_calls (session_id TEXT, tool_id TEXT, input_ref_json TEXT, output_ref_json TEXT, status TEXT, ended_at TEXT);
  `);
  session("current");
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("context workspace files", () => {
  it("searches the whole index after limiting the displayed list, including dotfiles and deep paths", async () => {
    for (let i = 0; i < 120; i++) write(`a/${i}.ts`);
    write("z/needle.ts");
    write(".config/settings.json");
    const deep = `${Array(22).fill("deep").join("/")}/last.ts`;
    write(deep);
    write("node_modules/package/hidden.ts");
    write(".git/objects/hidden");
    expect(
      await listTurnReferenceOptions("project", "file", "", "current"),
    ).toHaveLength(100);
    expect(
      await listTurnReferenceOptions(
        "project",
        "file",
        " Z\\NEEDLE ",
        "current",
      ),
    ).toEqual([{ kind: "file", id: "z/needle.ts", label: "z/needle.ts" }]);
    expect(
      (
        await listTurnReferenceOptions("project", "file", "last.ts", "current")
      )[0]?.id,
    ).toBe(deep);
    expect(
      await listTurnReferenceOptions("project", "file", "hidden", "current"),
    ).toEqual([]);
    expect(
      (
        await listTurnReferenceOptions("project", "file", ".config", "current")
      )[0]?.id,
    ).toBe(".config/settings.json");
  });

  it("uses the active worktree plus reference roots and keeps references injectable", async () => {
    write("active.ts");
    write("../primary/wrong-checkout.ts");
    write("../reference/shared.ts");
    mocks.members = [
      {
        role: "primary",
        status: "available",
        path: path.join(temp, "primary"),
      },
      {
        role: "reference",
        status: "available",
        path: path.join(temp, "reference"),
      },
    ];
    const files = await listTurnReferenceOptions(
      "project",
      "file",
      "",
      "current",
    );
    expect(files.map((file) => file.id)).toEqual([
      "active.ts",
      "../reference/shared.ts",
    ]);
    // Isolate reference membership validation from the tool permission policy.
    const { sandboxPolicy } = await import("../sandbox/index.js");
    vi.spyOn(sandboxPolicy, "resolve").mockImplementation((id, root) =>
      path.resolve(root, id),
    );
    expect(prepareTurnReferences("current", [files[1]!])?.content).toContain(
      "shared.ts",
    );
    expect(() =>
      prepareTurnReferences("current", [
        { kind: "file", id: "../primary/wrong-checkout.ts" },
      ]),
    ).toThrow("not in this workspace");
  });

  it("ranks persisted reads from all sessions newest first, deduplicates, and filters other workspaces", async () => {
    for (const file of ["a.ts", "new.ts", "old.ts", "failed.ts", "private.pem"])
      write(file);
    write("../other/new.ts");
    session("previous");
    session("other-worktree", path.join(temp, "other"));
    read("previous", "old.ts", "2026-01-01");
    read("previous", "new.ts", "2026-01-02", "completed", "claude.Read", {
      file_path: "new.ts",
    });
    read("current", "old.ts", "2026-01-03");
    read("current", "failed.ts", "2026-01-04", "failed");
    read("other-worktree", "new.ts", "2026-01-05");
    read("current", "private.pem", "2026-01-06");
    read("current", "deleted.ts", "2026-01-07");
    expect(
      (await listTurnReferenceOptions("project", "file", "", "current")).map(
        (file) => file.id,
      ),
    ).toEqual(["old.ts", "new.ts", "a.ts", "failed.ts"]);
    expect(
      (await listTurnReferenceOptions("project", "file", "", "current"))
        .filter((file) => file.recent)
        .map((file) => file.id),
    ).toEqual(["old.ts", "new.ts"]);
    read("previous", "a.ts", "2026-01-08");
    expect(
      (await listTurnReferenceOptions("project", "file", "", "current"))[0]?.id,
    ).toBe("a.ts");
  });

  it("includes explicitly read generated files and successful shell reads, never escaped symlinks", async () => {
    write("dist/generated.ts");
    write("shell.ts");
    write("../outside/secret.ts");
    fs.symlinkSync(
      path.join(temp, "outside"),
      path.join(mocks.root, "linked"),
      "dir",
    );
    read("current", "dist/generated.ts", "2026-01-01");
    read("current", "", "2026-01-02", "completed", "bash", {
      command: "cat shell.ts",
    });
    read("current", "linked/secret.ts", "2026-01-03");
    expect(
      (await listTurnReferenceOptions("project", "file", "", "current")).map(
        (file) => file.id,
      ),
    ).toEqual(["shell.ts", "dist/generated.ts"]);
  });

  it("shares in-flight indexes and refreshes new and deleted files after expiry", async () => {
    write("before.ts");
    const first = workspaceFileIndex(mocks.root);
    expect(workspaceFileIndex(mocks.root)).toBe(first);
    await first;
    expect(workspaceFileIndex(mocks.root)).toBe(first);
    fs.unlinkSync(path.join(mocks.root, "before.ts"));
    write("after.ts");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);
    expect(await workspaceFileIndex(mocks.root)).toEqual([
      path.join(mocks.root, "after.ts"),
    ]);
  });

  it("does not share visibility decisions between sessions or accept a mismatched project", async () => {
    write("private.pem");
    expect(await workspaceFileIndex(mocks.root)).toContain(
      path.join(mocks.root, "private.pem"),
    );
    expect(
      await listTurnReferenceOptions("project", "file", "", "current"),
    ).toEqual([]);
    await expect(
      listTurnReferenceOptions("other", "file", "", "current"),
    ).rejects.toThrow("does not belong");
  });
});
