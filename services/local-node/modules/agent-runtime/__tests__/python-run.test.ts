import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePythonRuntime } from "../../../infrastructure/runtime/python-runtime.js";
import { pythonRunTool } from "../tools/python-run.js";
import { toolRegistry } from "../tool-registry.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";
import { clearSessionFileReads } from "../read-tracker.js";
import { resolvePermissionDecision } from "../permission-policy.js";
import { toolResourcePolicy } from "../resource-admission.js";
import { DEFAULT_TIMEOUT_MS, MAX_CODE_CHARS, pythonRunTimeout } from "../python-execution/limits.js";
import { runPythonCode } from "../python-execution/runner.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

interface Outcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  guardViolation: string | null;
  sandbox: string;
  script: string;
  cwd: string;
}

const available = Boolean(resolvePythonRuntime());
let root: string;
let sessionId: string;

beforeAll(resetAgentRuntimeFixtures);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-python-run-test-")));
  sessionId = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(sessionId, root);
});
afterEach(() => {
  clearSessionWorkspaceRoot(sessionId);
  clearSessionFileReads(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

function run(code: string, extra: Record<string, unknown> = {}, abortSignal?: AbortSignal) {
  return pythonRunTool.execute({
    sessionId, runId: null, stepId: null, toolCallId: "python-run-test",
    toolId: "python.run", category: "shell", mutability: "read",
    args: { code, ...extra }, abortSignal,
  });
}
const outcome = (value: Awaited<ReturnType<typeof run>>) => value.result as Outcome;

describe("python.run registration and contract", () => {
  it("mounts as an approved-by-default shell capability when Python exists", () => {
    if (!available) return expect(toolRegistry.list().some((tool) => tool.id === "python.run")).toBe(false);
    const tool = toolRegistry.get("python.run");
    expect(tool.category).toBe("shell");
    expect(tool.internalGate).toBe("shell");
    expect(tool.getPattern?.({ code: "print(1)" })).toBe("python.run");
    const session = agentRuntimeStore.getSession(sessionId);
    expect(resolvePermissionDecision({
      sessionId, category: "shell", internalGate: "shell", pattern: "python.run",
      rules: session.permissionRules, isSubSession: false,
    }).action).toBe("ask");
    // Arbitrary code shares the command pool so it cannot bypass build/test limits.
    expect(toolResourcePolicy(tool, { code: "print(1)", timeoutMs: 5_000 }))
      .toEqual({ resource: "command", timeoutMs: 35_000 });
  });

  it("rejects invalid arguments and clamps the timeout window", () => {
    const schema = pythonRunTool.inputSchema!;
    expect(schema.safeParse({ code: "print(1)" }).success).toBe(true);
    expect(schema.safeParse({ code: "print(1)", args: ["", "with spaces", "中文"] }).success).toBe(true);
    for (const args of [
      {}, { code: "" }, { code: "   \n" }, { code: "x".repeat(MAX_CODE_CHARS + 1) },
      { code: "print(1)", timeoutMs: 999 }, { code: "print(1)", timeoutMs: 600_001 },
      { code: "print(1)", workdir: "" }, { code: "print(1)", stdin: "a".repeat(1_000_001) },
      { code: "print(1)", args: [1] },
    ])
      expect(schema.safeParse(args).success, JSON.stringify(args).slice(0, 60)).toBe(false);
    expect(pythonRunTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(pythonRunTimeout(500)).toBe(1_000);
    expect(pythonRunTimeout(10 * 60_000 * 4)).toBe(600_000);
  });
});

describe.skipIf(!available)("real Python execution in the session sandbox", () => {
  it("executes source from memory without staging source, guard or config files", async () => {
    const result = await run([
      "import os, pathlib, sys",
      "assert not pathlib.Path(__file__).exists()",
      "assert list(pathlib.Path(__file__).parent.iterdir()) == []",
      "assert not any(p.is_file() for p in pathlib.Path(os.environ['SYNAX_SANDBOX']).rglob('*'))",
      "assert sys.flags.isolated == 1 and sys.dont_write_bytecode",
      "assert __name__ == '__main__' and sys.argv == [__file__]",
      "print('hello', sys.version_info[0])",
    ].join("\n"));
    expect(result.outcome).toBeUndefined();
    const output = outcome(result);
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toBe("hello 3");
    expect(output.cwd).toBe(".");
    expect(path.isAbsolute(output.sandbox)).toBe(true);
    expect(fs.existsSync(output.sandbox)).toBe(true);
    expect(fs.existsSync(path.dirname(output.script))).toBe(false);
    expect(result.displaySummary).toContain("exit 0");
  }, 20_000);

  it("passes argv losslessly through the envelope and forwards the owned-process startup callback", async () => {
    const args = ["", "with spaces", "--flag", "中文", 'a"b', "line\nbreak"];
    const onStarted = vi.fn();
    const result = await runPythonCode({
      sessionId, cwd: root, args, onStarted,
      code: "import json, sys\nprint(json.dumps([sys.argv, __file__]))\n",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([[result.script, ...args], result.script]);
    expect(onStarted).toHaveBeenCalledOnce();
    const tool = outcome(await run("import json, sys\nprint(json.dumps(sys.argv[1:]))\n", { args }));
    expect(JSON.parse(tool.stdout)).toEqual(args);
  }, 20_000);

  it("separates text and binary user stdin from the private envelope and documents raw fd EOF", async () => {
    const text = outcome(await run([
      "import io, os, sys",
      "assert sys.stdin is sys.__stdin__",
      "assert os.read(0, 100000) == b''",
      "try:",
      "    sys.stdin.fileno()",
      "except io.UnsupportedOperation:",
      "    pass",
      "else:",
      "    raise AssertionError('memory stdin must not advertise fd 0')",
      "print(input())",
      "print(repr(sys.stdin.read()))",
    ].join("\n"), { stdin: "你好\r\nsecond\n" }));
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toBe("你好\n'second\\n'\n");
    const binary = outcome(await run(
      "import sys\nprint(sys.stdin.buffer.read().hex())\n",
      { stdin: "二进制\r\n\u0000" },
    ));
    expect(binary.exitCode).toBe(0);
    expect(binary.stdout.trim()).toBe(Buffer.from("二进制\r\n\u0000", "utf8").toString("hex"));
    const empty = outcome(await run("import sys\nprint(repr(sys.stdin.read()))\n"));
    expect(empty.stdout.trim()).toBe("''");
  }, 20_000);

  it("compiles all source before running any statement so late syntax errors have no user side effects", async () => {
    const result = outcome(await run(
      "from pathlib import Path\nPath('must-not-exist.txt').write_text('side effect')\nprint('must not print')\nif True print('invalid')\n",
    ));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SyntaxError");
    expect(result.stdout).toBe("");
    expect(result.guardViolation).toBeNull();
    expect(fs.existsSync(path.join(root, "must-not-exist.txt"))).toBe(false);
    expect(fs.existsSync(path.dirname(result.script))).toBe(false);
  }, 20_000);

  it("keeps the persistent sandbox between calls and passes stdin and HOME", async () => {
    const first = outcome(await run(
      "import os, pathlib\npathlib.Path(os.environ['SYNAX_SANDBOX'], 'cached.txt').write_text('kept', encoding='utf-8')\npathlib.Path(os.environ['SYNAX_SANDBOX'], 'persisted_helper.py').write_text('value = 42', encoding='utf-8')\nprint(os.path.isdir(os.environ['HOME']))\n",
    ));
    expect(first.exitCode).toBe(0);
    expect(first.stdout.trim()).toBe("True");
    const second = outcome(await run(
      "import os, pathlib, sys, persisted_helper\nassert persisted_helper.value == 42\nprint(pathlib.Path(os.environ['SYNAX_SANDBOX'], 'cached.txt').read_text(encoding='utf-8'))\nprint(sys.stdin.read().strip())\n",
      { stdin: "piped\n" },
    ));
    expect(second.stdout.trim()).toBe("kept\npiped");
  }, 20_000);

  it("reports the exit code and stderr of a failing script", async () => {
    const failed = outcome(await run("import sys\nprint('before')\nsys.exit(3)\n"));
    expect(failed.exitCode).toBe(3);
    expect(failed.stdout.trim()).toBe("before");
    const raised = await run("raise RuntimeError('boom')\n");
    expect(outcome(raised).exitCode).toBe(1);
    expect(outcome(raised).stderr).toContain("RuntimeError: boom");
    expect(outcome(raised).guardViolation).toBeNull();
    expect(raised.outcome).toBeUndefined();
  }, 20_000);

  it("allows writes inside the workspace and reports them from a fresh call", async () => {
    const result = outcome(await run(
      "from pathlib import Path\nPath('report.txt').write_text('generated', encoding='utf-8')\nprint(Path('report.txt').read_text(encoding='utf-8'))\n",
    ));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("generated");
    expect(fs.readFileSync(path.join(root, "report.txt"), "utf8")).toBe("generated");
  }, 20_000);

  it("blocks reads and writes outside the workspace even when the script catches the error", async () => {
    const outside = path.join(os.tmpdir(), `synax-python-escape-${process.pid}.txt`);
    const write = await run(
      `from pathlib import Path\ntry:\n    Path(${JSON.stringify(outside)}).write_text('x', encoding='utf-8')\nexcept PermissionError as error:\n    print('blocked')\n`,
    );
    expect(fs.existsSync(outside)).toBe(false);
    expect(outcome(write).exitCode).toBe(0);
    expect(write.outcome).toBe("failed");
    expect(write.displaySummary).toContain("blocked");
    expect(outcome(write).guardViolation).toContain("escapes the workspace");

    fs.writeFileSync(outside, "secret");
    try {
      const read = await run(`print(open(${JSON.stringify(outside)}, encoding='utf-8').read())\n`);
      expect(outcome(read).exitCode).toBe(1);
      expect(outcome(read).guardViolation).toContain("escapes the workspace");
      expect(outcome(read).stderr).toContain("[sandbox]");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  }, 20_000);

  it("blocks network access, child processes and links", async () => {
    const network = outcome(await run("import socket\nsocket.create_connection(('127.0.0.1', 9), timeout=0.2)\n"));
    expect(network.exitCode).toBe(1);
    expect(network.guardViolation).toContain("socket");
    const child = outcome(await run("import subprocess\nsubprocess.run(['echo', 'x'])\n"));
    expect(child.exitCode).toBe(1);
    expect(child.guardViolation).toContain("subprocess");
    const link = outcome(await run("import os\nos.symlink('a', 'b')\n"));
    expect(link.exitCode).toBe(1);
    expect(link.guardViolation).toContain("Links are not permitted");
  }, 20_000);

  it("kills a timed-out script but keeps the output it printed", async () => {
    const result = await run("import time\nprint('before', flush=True)\ntime.sleep(30)\n", { timeoutMs: 1_000 });
    const output = outcome(result);
    expect(output.timedOut).toBe(true);
    expect(output.stdout).toContain("before");
    expect(output.stderr).toContain("TIMED OUT after 1s");
    expect(result.displaySummary).toContain("timed out");
  }, 30_000);

  it("truncates long streams and honours workdir", async () => {
    fs.mkdirSync(path.join(root, "nested"));
    const nested = outcome(await run("import os\nprint(os.path.basename(os.getcwd()))\n", { workdir: "nested" }));
    expect(nested.cwd).toBe("nested");
    expect(nested.stdout.trim()).toBe("nested");
    const long = outcome(await run("print('x' * 200000)\n"));
    expect(long.stdout).toContain("STDOUT TRUNCATED");
    expect(Buffer.byteLength(long.stdout)).toBeLessThan(70_000);
  }, 20_000);

  it("rejects a workdir outside the workspace", async () => {
    const result = await run("print(1)\n", { workdir: os.tmpdir() });
    expect(result.outcome).toBe("failed");
    expect(fs.existsSync(path.join(root, "report.txt"))).toBe(false);
  }, 20_000);

  it("enforces the stream cap in bytes for multibyte output", async () => {
    const wide = outcome(await run("print('中' * 40000)\n"));
    expect(wide.stdout).toContain("STDOUT TRUNCATED");
    expect(Buffer.byteLength(wide.stdout)).toBeLessThanOrEqual(64_000 + 200);
    expect(wide.stdout).toContain("中");
  }, 20_000);

  it("names a missing or non-directory workdir instead of a spawn error", async () => {
    const missing = await run("print(1)\n", { workdir: "does-not-exist" });
    expect(missing.outcome).toBe("failed");
    expect(missing.displaySummary).toContain("workdir does not exist");
    fs.writeFileSync(path.join(root, "plain.txt"), "x");
    const file = await run("print(1)\n", { workdir: "plain.txt" });
    expect(file.outcome).toBe("failed");
    expect(file.displaySummary).toContain("workdir is not a directory");
  }, 20_000);

  it("sweeps a run directory orphaned by a hard-killed call", async () => {
    const first = outcome(await run("print('first')\n"));
    const stale = path.join(first.sandbox, "run-swept");
    const fresh = path.join(first.sandbox, "run-kept");
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    outcome(await run("print('second')\n"));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh, { recursive: true, force: true });
  }, 20_000);

  it("confines script writes to a delegated writeScope while keeping workspace reads", async () => {
    agentRuntimeStore.updateSessionMetadata(sessionId, {
      subagentProfile: {
        version: 1,
        parentSessionId: "ars_parent",
        workspaceRoot: root,
        profile: { writeScope: ["scoped"] },
        capabilities: ["python.run"],
      },
    });
    fs.mkdirSync(path.join(root, "scoped"));
    fs.writeFileSync(path.join(root, "outside.txt"), "keep");
    const allowed = outcome(await run(
      "from pathlib import Path\nprint(Path('outside.txt').read_text(encoding='utf-8'))\nPath('scoped/ok.txt').write_text('ok', encoding='utf-8')\n",
    ));
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("keep");
    expect(fs.readFileSync(path.join(root, "scoped", "ok.txt"), "utf8")).toBe("ok");
    const denied = await run("from pathlib import Path\ntry:\n    Path('outside.txt').write_text('no', encoding='utf-8')\nexcept PermissionError:\n    print('caught')\n");
    expect(denied.outcome).toBe("failed");
    expect(outcome(denied).exitCode).toBe(0);
    expect(outcome(denied).stdout.trim()).toBe("caught");
    expect(outcome(denied).guardViolation).toContain("assigned write scope");
    expect(fs.readFileSync(path.join(root, "outside.txt"), "utf8")).toBe("keep");
  }, 20_000);

  it("resolves symlinks, blocked extensions and chdir against the same boundary", async () => {
    fs.writeFileSync(path.join(root, "secret.pem"), "key");
    const blocked = await run("print(open('secret.pem', encoding='utf-8').read())\n");
    expect(outcome(blocked).guardViolation).toContain("Blocked extension");
    const chdir = await run("import os\nos.chdir('..')\n");
    expect(outcome(chdir).exitCode).toBe(1);
    if (process.platform === "win32") return;
    const escape = path.join(root, "escape");
    fs.symlinkSync(os.tmpdir(), escape, "dir");
    const leaked = path.join(os.tmpdir(), `synax-python-symlink-${process.pid}.txt`);
    const throughLink = await run(`from pathlib import Path\nPath(${JSON.stringify(path.join(escape, path.basename(leaked)))}).write_text('x', encoding='utf-8')\n`);
    expect(outcome(throughLink).guardViolation).toContain("escapes the workspace");
    expect(fs.existsSync(leaked)).toBe(false);
  }, 20_000);
});

describe.skipIf(!available)("python.run through the tool registry", () => {
  it("suspends for shell approval before any interpreter starts", async () => {
    const result = await toolRegistry.execute(sessionId, "python.run", { code: "print('unapproved')\n" });
    expect(result.permission?.action).toBe("ask");
    expect(result.record.status).toBe("pending");
  });

  it("runs with granted shell permission and keeps the structured receipt", async () => {
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [{ gate: "shell", pattern: "*", action: "allow" }] });
    const result = await toolRegistry.execute(sessionId, "python.run", {
      code: "from pathlib import Path\nPath('registry.txt').write_text('ok', encoding='utf-8')\nprint('registered')\n",
    });
    expect(result.record.status, JSON.stringify(result.record)).toBe("completed");
    expect(result.record.outputRef).toMatchObject({ exitCode: 0, stdout: "registered\n", cwd: "." });
    // The workspace mutation lease covers a write made by the script, not by Node.
    expect(fs.readFileSync(path.join(root, "registry.txt"), "utf8")).toBe("ok");
  }, 20_000);
});
