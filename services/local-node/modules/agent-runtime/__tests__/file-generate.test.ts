import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePythonRuntime } from "../../../infrastructure/runtime/python-runtime.js";
import { fileGenerateTool } from "../tools/file-generate.js";
import { toolRegistry, ToolRegistry } from "../tool-registry.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";
import { recordSessionFileRead, assertSessionFileReadForWrite, clearSessionFileReads } from "../read-tracker.js";
import { runGenerationScript, readGenerationManifest, type GenerationPlan } from "../file-generation/runner.js";
import { commitGeneration } from "../file-generation/commit.js";
import { normalizeStagedOperations } from "../file-generation/staged-ops.js";
import { diffStats } from "../file-generation/diff-stats.js";
import { generationTimeout, MAX_FILE_BYTES, decodeText } from "../file-generation/limits.js";
import { resolvePermissionDecision } from "../permission-policy.js";
import { canComposeTool } from "../code-mode/policy.js";
import { withWorkspaceMutation } from "../workspace-mutation.js";
import { assertSpecialistToolAllowed, buildSpecialistChildInput, specialistBaseProfile } from "../specialist-profile.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let root: string;
let sessionId: string;
const available = Boolean(resolvePythonRuntime());
beforeAll(resetAgentRuntimeFixtures);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-generation-test-")));
  sessionId = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(sessionId, root);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  clearSessionWorkspaceRoot(sessionId); clearSessionFileReads(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});
const file = (name: string) => path.join(root, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
const put = (name: string, text: string) => fs.writeFileSync(file(name), text);
const plan = (operations: GenerationPlan["operations"]): GenerationPlan => ({ operations, reads: [], requiresDelete: [], diagnostics: { stdout: "", stderr: "" } });
const execute = (script: string, timeoutMs?: number, abortSignal?: AbortSignal) => fileGenerateTool.execute({
  sessionId, runId: null, stepId: null, toolCallId: "generate-test", toolId: "file.generate", category: "write", mutability: "write", args: { script, timeoutMs }, abortSignal,
});

describe("generation validation and transactions", () => {
  it("normalizes repeated writes and write/delete order by canonical path", () => {
    const ops = normalizeStagedOperations(sessionId, [
      { type: "write", path: "a", content: "first" }, { type: "delete", path: "./a" },
      { type: "write", path: "a", content: "last" }, { type: "write", path: "b", content: "x" }, { type: "delete", path: "b" },
    ]);
    expect(ops.map(({ type, content }) => ({ type, content }))).toEqual([{ type: "write", content: "last" }, { type: "delete", content: undefined }]);
  });
  it("rejects count, per-file, total, NUL, traversal and conflicting paths", () => {
    for (const operations of [
      Array.from({ length: 121 }, (_, i) => ({ type: "write" as const, path: `${i}.txt`, content: "" })),
      [{ type: "write" as const, path: "a", content: "x".repeat(MAX_FILE_BYTES + 1) }],
      Array.from({ length: 9 }, (_, i) => ({ type: "write" as const, path: `${i}`, content: "x".repeat(MAX_FILE_BYTES) })),
      [{ type: "write" as const, path: "a", content: "\0" }],
      [{ type: "write" as const, path: "../escape", content: "x" }],
      [{ type: "write" as const, path: "a", content: "x" }, { type: "write" as const, path: "a/b", content: "x" }],
    ]) expect(() => normalizeStagedOperations(sessionId, operations)).toThrow();
    expect(() => decodeText(Buffer.from([0xff]))).toThrow();
  });
  it("validates all targets before creating even the first parent directory", async () => {
    fs.mkdirSync(file("directory"));
    await expect(commitGeneration(sessionId, plan([{ type: "write", path: "new/a", content: "x" }, { type: "write", path: "directory", content: "x" }]))).rejects.toThrow(/regular text file/);
    expect(fs.readdirSync(root)).toEqual(["directory"]);
  });
  it("rejects external symlink destinations", async () => {
    fs.symlinkSync(os.tmpdir(), file("outside"), process.platform === "win32" ? "junction" : "dir");
    await expect(commitGeneration(sessionId, plan([{ type: "write", path: "outside/escape.txt", content: "x" }]))).rejects.toThrow(/boundary/);
  });
  it("preserves byte content, BOM, CRLF, mode and refreshes the read tracker", async () => {
    put("a", "before"); fs.chmodSync(file("a"), 0o744);
    const content = "\uFEFFhello\r\n世界\r\n";
    const result = await commitGeneration(sessionId, plan([{ type: "write", path: "a", content }]));
    expect(result.error).toBeUndefined(); expect(read("a")).toBe(content);
    if (process.platform !== "win32") expect(fs.statSync(file("a")).mode & 0o777).toBe(0o744);
    expect(() => assertSessionFileReadForWrite(sessionId, "a")).not.toThrow();
  });
  it("refuses a file changed since the session read it", async () => {
    put("a", "before"); recordSessionFileRead(sessionId, "a", "before"); put("a", "external edit");
    await expect(commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "replacement" }]))).rejects.toThrow(/changed on disk/);
    expect(read("a")).toBe("external edit");
  });
  it("rolls back writes, deletes, moves and newly created directories after a mid-commit failure", async () => {
    put("a", "original"); put("old", "moved"); put("deleted", "keep");
    const rename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file("new/failure") && !failed) { failed = true; throw new Error("Injected disk failure"); }
      return rename(from, to);
    });
    const result = await commitGeneration(sessionId, plan([
      { type: "write", path: "a", content: "changed" }, { type: "delete", path: "old", movePath: "new/moved" },
      { type: "write", path: "new/moved", content: "moved" }, { type: "delete", path: "deleted" },
      { type: "write", path: "new/failure", content: "fail" },
    ]));
    expect(result).toMatchObject({ rolledBack: true, error: "Injected disk failure" });
    expect(read("a")).toBe("original"); expect(read("old")).toBe("moved"); expect(read("deleted")).toBe("keep");
    expect(fs.existsSync(file("new"))).toBe(false);
    expect(() => assertSessionFileReadForWrite(sessionId, "a")).not.toThrow();
  });
  it("reports residual paths when rollback also fails", async () => {
    put("a", "original"); const rename = fs.renameSync; let fail = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file("b")) fail = true;
      if (fail) throw new Error("Disk unavailable");
      return rename(from, to);
    });
    const result = await commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "changed" }, { type: "write", path: "b", content: "x" }]));
    expect(result.rolledBack).toBeUndefined(); expect(result.residualPaths).toContain("a"); expect(read("a")).toBe("changed");
  });
  it("preserves an external edit made between transaction writes", async () => {
    put("a", "original-a"); put("b", "original-b");
    const rename = fs.renameSync; let edited = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === file("a") && !edited) { edited = true; put("b", "external edit"); }
    });
    const result = await commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "changed" }, { type: "write", path: "b", content: "changed" }]));
    expect(result).toMatchObject({ rolledBack: true, error: expect.stringContaining("changed on disk before commit") });
    expect(read("a")).toBe("original-a"); expect(read("b")).toBe("external edit");
  });
  it("reports a leftover temporary file when cleanup fails", async () => {
    put("a", "original"); const rename = fs.renameSync; const remove = fs.rmSync; let failed = false; let cleanupFailed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!failed) { failed = true; throw new Error("Injected rename failure"); }
      return rename(from, to);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (!cleanupFailed && String(target).includes(".synax-generate-") && fs.existsSync(target)) {
        cleanupFailed = true; throw new Error("Injected cleanup failure");
      }
      return remove(target, options);
    });
    const result = await commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "changed" }]));
    expect(result.rolledBack).toBeUndefined(); expect(result.residualPaths).toHaveLength(1);
    expect(fs.existsSync(file(result.residualPaths![0]))).toBe(true); expect(read("a")).toBe("original");
  });
  it("enforces file.delete and per-path write denials before writing", async () => {
    put("a", "keep");
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [{ gate: "delete", pattern: "*", action: "deny" }] });
    await expect(commitGeneration(sessionId, plan([{ type: "delete", path: "a" }]))).rejects.toThrow(/deny/);
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [{ gate: "write", pattern: "a", action: "deny" }] });
    await expect(commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "x" }]))).rejects.toThrow(/deny/);
    expect(read("a")).toBe("keep");
  });
  it("requires approval, denies child writes by default, and excludes code mode", async () => {
    expect(resolvePermissionDecision({ sessionId, category: "write", internalGate: "write", pattern: "file.generate" }).action).toBe("ask");
    expect(resolvePermissionDecision({ sessionId, category: "write", internalGate: "write", pattern: "file.generate", isSubSession: true }).action).toBe("deny");
    expect(canComposeTool(agentRuntimeStore.getSession(sessionId), fileGenerateTool)).toBe(false);
    if (available) {
      const result = await toolRegistry.execute(sessionId, "file.generate", { script: 'import synax; synax.write("a", "x")' });
      expect(result.permission?.action).toBe("ask"); expect(fs.existsSync(file("a"))).toBe(false);
    }
  });
  it("cancels while waiting for the workspace lock without writing", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const lock = withWorkspaceMutation(sessionId, async () => {
      acquired(); await new Promise<void>(resolve => { release = resolve; });
    }, false, [file("a")]);
    await held;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(commitGeneration(sessionId, plan([{ type: "write", path: "a", content: "x" }]), controller.signal)).rejects.toThrow();
      expect(fs.existsSync(file("a"))).toBe(false);
    } finally { clearTimeout(timer); release(); await lock; }
  });
  it("omits the tool entirely when no runtime is available", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SYNAX_PYTHON_RUNTIME", file("missing-python"));
    expect(new ToolRegistry().list().some(tool => tool.id === "file.generate")).toBe(false);
  });
  it("enforces specialist generated paths and explicit delete capability", () => {
    const parent = agentRuntimeStore.getSession(sessionId);
    const parentProfile = { ...specialistBaseProfile, id: parent.profileId, mode: "primary" as const, allowedCapabilities: [...specialistBaseProfile.allowedCapabilities, "subagent.delegate"], toolPolicy: { allowSubtasks: true } };
    const input = buildSpecialistChildInput(parent, { specialist: { name: "Generator", role: "Generate", instructions: "Generate", capabilities: ["file.generate"], skillIds: [], writeScope: ["src"] }, prompt: "Generate files" }, parentProfile);
    const child = { ...parent, ...input, id: `${sessionId}-child`, profileId: "specialist", parentSessionId: sessionId, sessionMetadata: input.sessionMetadata! };
    try {
      expect(() => assertSpecialistToolAllowed(child, "file.generate", { script: "pass" })).not.toThrow();
      expect(() => assertSpecialistToolAllowed(child, "file.generate", { path: "src/a" })).not.toThrow();
      expect(() => assertSpecialistToolAllowed(child, "file.generate", { path: "other/a" })).toThrow(/writeScope/);
      expect(() => assertSpecialistToolAllowed(child, "file.delete", { path: "src/a" })).toThrow(/not assigned/);
    } finally { clearSessionWorkspaceRoot(child.id); }
  });
  it("computes bounded line statistics and clamps script timeouts", () => {
    expect(diffStats("a\nb\nc\n", "a\nx\nc\n")).toEqual({ additions: 1, deletions: 1 });
    expect(diffStats("", "a\nb")).toEqual({ additions: 2, deletions: 0 });
    expect(diffStats("x".repeat(1024 * 1024 + 1), "")).toEqual({});
    expect([generationTimeout(), generationTimeout(-1), generationTimeout(999999)]).toEqual([30000, 1000, 120000]);
  });
  it("rejects incomplete manifests, traversal content paths and invalid UTF-8", () => {
    fs.mkdirSync(file("staging"));
    for (const manifest of ["", '{"type":"write","path":"a","contentFile":"../secret"}\n{"type":"complete","version":1}', '{"type":"complete","version":2}']) {
      put("manifest.jsonl", manifest); expect(() => readGenerationManifest(root)).toThrow();
    }
    fs.writeFileSync(file("staging/0.txt"), Buffer.from([0xff]));
    put("manifest.jsonl", '{"type":"write","path":"a","contentFile":"0.txt"}\n{"type":"complete","version":1}');
    expect(() => readGenerationManifest(root)).toThrow();
  });
});

describe.skipIf(!available)("real Python file generation (requires bundled Python or development python3)", () => {
  it("executes through the registry with granted write permission and retains the file receipt", async () => {
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [{ gate: "write", pattern: "*", action: "allow" }] });
    const result = await toolRegistry.execute(sessionId, "file.generate", { script: 'import synax; synax.write("registered.txt", "through registry")' });
    expect(result.record.status, JSON.stringify(result.record)).toBe("completed");
    expect(result.record.outputRef).toMatchObject({ files: [{ path: "registered.txt", action: "add", bytes: 16 }] });
    expect(read("registered.txt")).toBe("through registry");
  });
  it("generates three scaffold files from a template and long escape-sensitive text", async () => {
    const result = await execute('import synax\nassert __name__ == "__main__"\nfor name in ["component.ts", "style.css", "test.ts"]:\n    synax.write("src/" + name, "// " + name + "\\n")\nsynax.write("long.txt", \'quotes: " \\\\ \\t 世界\\r\\n\' * 10000)\nprint("generated")');
    expect(result.outcome, JSON.stringify(result.result)).toBeUndefined();
    expect(fs.readdirSync(file("src"))).toHaveLength(3); expect(read("long.txt")).toContain('quotes: " \\ \t 世界\r\n');
    expect(result.result).toMatchObject({ diagnostics: { stdout: "generated\n" }, totals: { files: 4 } });
  });
  it("reads and transforms files with synax and pathlib, preserving staged order and move chains", async () => {
    put("a", "hello"); put("remove", "old");
    const result = await execute('import synax\nfrom pathlib import Path\nassert Path("a").read_text() == "hello"\nsynax.write("a", synax.read("a").upper())\nsynax.move("a", "b")\nsynax.move("b", "c")\nassert not synax.exists("a")\nassert synax.read("c") == "HELLO"\nsynax.write("c", "last")\nsynax.delete("remove")\nassert "c" in synax.list_dir(".")');
    expect(result.outcome, JSON.stringify(result.result)).toBeUndefined(); expect(read("c")).toBe("last");
    expect(fs.readdirSync(root)).toEqual(["c"]);
    expect(result.artifacts[0]?.risk).toBe("high");
  });
  it.each([
    'open("direct", "w").write("bad")',
    'import pathlib; pathlib.Path("direct").write_text("bad")',
    'import subprocess; subprocess.run(["echo", "bad"])',
    'import socket; socket.socket().connect(("127.0.0.1", 80))',
    'import ctypes; ctypes.CDLL(None)',
    'import os; os.truncate("existing", 0)',
    'import os; os.chmod("existing", 0o777)',
    'import os; os.rename("existing", "renamed")',
    'import atexit; atexit.register(lambda: open("direct", "w"))',
    'open("secret.key").read()',
    'raise RuntimeError("failure")',
    'import sys; sys.exit(7)',
    'import sys; sys.exit(0)',
    'if invalid syntax',
  ])("rejects %s with no workspace writes", async script => {
    put("existing", "keep"); put("secret.key", "private");
    const result = await execute('import synax\nsynax.write("planned", "never committed")\n' + script);
    expect(result.outcome).toBe("failed"); expect(read("existing")).toBe("keep");
    expect(fs.readdirSync(root).sort()).toEqual(["existing", "secret.key"]);
  });
  it("rejects absolute external writes, reads and listing, including caught audit violations", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "synax-generation-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret"), "private");
      for (const script of [`open(${JSON.stringify(path.join(outside, "write"))}, "w")`, `open(${JSON.stringify(path.join(outside, "secret"))}).read()`, `import os; os.listdir(${JSON.stringify(outside)})`, 'try:\n    open("direct", "w")\nexcept PermissionError:\n    pass']) {
        expect((await execute('import synax\nsynax.write("a", "x")\n' + script)).outcome).toBe("failed");
        expect(fs.readdirSync(root)).toEqual([]);
      }
      expect(fs.readdirSync(outside)).toEqual(["secret"]);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it("times out and cancels without committing staged output", async () => {
    const script = 'import synax\nsynax.write("a", "x")\nwhile True: pass';
    expect((await execute(script, 1000)).result).toMatchObject({ error: expect.stringMatching(/timed out/) });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200);
    try { expect((await execute(script, 30000, controller.signal)).outcome).toBe("failed"); } finally { clearTimeout(timer); }
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("keeps diagnostics bounded and removes provider credentials from the child", async () => {
    vi.stubEnv("SYNAX_TEST_PROVIDER_SECRET", "hidden"); vi.stubEnv("HTTP_PROXY", "private-proxy");
    const result = await execute('import os, sys\nassert "SYNAX_TEST_PROVIDER_SECRET" not in os.environ\nassert "HTTP_PROXY" not in os.environ\nprint("x" * 20000)\nprint("y" * 20000, file=sys.stderr)');
    expect(result.outcome, JSON.stringify(result.result)).toBeUndefined();
    const output = result.result as { diagnostics: { stdout: string; stderr: string } };
    expect(Buffer.byteLength(output.diagnostics.stdout)).toBeLessThanOrEqual(8192); expect(Buffer.byteLength(output.diagnostics.stderr)).toBeLessThanOrEqual(8192);
  });
  it("revalidates read snapshots after the script and before commit", async () => {
    put("a", "original");
    const staged = await runGenerationScript(sessionId, 'import synax; synax.write("b", synax.read("a"))');
    put("a", "external");
    await expect(commitGeneration(sessionId, staged)).rejects.toThrow(/changed on disk/);
    expect(fs.existsSync(file("b"))).toBe(false);
  });
});
