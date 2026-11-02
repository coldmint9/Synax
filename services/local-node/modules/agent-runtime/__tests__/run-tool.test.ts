import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTool } from "../tools/run.js";
import { toolRegistry } from "../tool-registry.js";
import { agentRuntimeStore } from "../session-store.js";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { permissionPolicy } from "../permission-policy.js";
import { permissionRulesForTier } from "../permission-tiers.js";
import { clearSessionScripts, rememberScript } from "../script-execution/cache.js";
import { sandboxPolicy } from "../sandbox/index.js";

let root: string;
let sessionId: string;

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-run-tool-test-")));
  sessionId = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(sessionId, root);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSessionScripts(sessionId);
  clearSessionScripts(`${sessionId}-foreign`);
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

function call(args: unknown) {
  return runTool.execute({
    sessionId, runId: null, stepId: null, toolCallId: "run-tool-test",
    toolId: "run", category: "shell", mutability: "read", args,
  });
}

function stubExecution() {
  return vi.spyOn(runTool, "execute").mockResolvedValue({
    result: { exitCode: 0 }, displaySummary: "stubbed run", artifacts: [],
  });
}

function invocationOptions() {
  const run = agentRuntimeStore.appendRun({
    id: "run-input", sessionId, status: "running", model: null,
    startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null,
    currentStep: 1, stopReason: null, metadata: {},
  });
  const step = agentRuntimeStore.appendRunStep({
    id: "step-input", sessionId, runId: run.id, index: 1, status: "running",
    model: null, startedAt: run.startedAt, completedAt: null, finishReason: null, metadata: {},
  });
  return { runId: run.id, stepId: step.id, modelToolCallId: "provider-run-call" };
}

describe("run tool", () => {
  it("executes literal argv without a shell and preserves stdin", async () => {
    const result = await call({
      argv: [process.execPath, "--input-type=module", "--eval", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),stdin:await new Promise(resolve => { let v=''; process.stdin.on('data', c => v += c); process.stdin.on('end', () => resolve(v)); })}))", "--", "$(not shell)", "two words"],
      stdin: "input\n",
    });
    expect(result.result).toMatchObject({ exitCode: 0, stdout: '{"args":["$(not shell)","two words"],"stdin":"input\\n"}' });
    expect(result.outcome).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  }, 20_000);

  it("runs a shell source after whole-source syntax validation without partial effects", async () => {
    const result = await call({ language: "sh", source: ["touch should-not-exist", "if then"] });
    expect(result.outcome).toBe("failed");
    expect((result.result as { syntaxError?: boolean }).syntaxError).toBe(true);
    expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false);
  }, 20_000);

  it("runs Python in memory with an independent stdin and no main.py source", async () => {
    const result = await call({ language: "python", source: "import sys; print(sys.argv[1]); print(sys.stdin.read().strip())", args: ["arg"], stdin: "data\n" });
    expect(result.result).toMatchObject({ exitCode: 0, stdout: "arg\ndata\n" });
    const sandbox = (result.result as { sandbox?: string }).sandbox;
    expect(sandbox).toBeTruthy();
    const hasSource = fs.readdirSync(sandbox!, { withFileTypes: true }).some(entry => entry.name === "main.py");
    expect(hasSource).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 20_000);

  it("caches source as an immutable session-local scriptId and reuses it", async () => {
    const first = await call({ language: "node", source: "console.log('cached')" });
    const scriptId = (first.result as { scriptId?: string }).scriptId;
    expect(scriptId).toMatch(/^/);
    const second = await call({ scriptId });
    expect(second.result).toMatchObject({ scriptId, exitCode: 0, stdout: "cached\n" });
  }, 20_000);

  it("uses the normal registry shell approval and returns a structured receipt", async () => {
    const pending = await toolRegistry.execute(sessionId, "run", { language: "node", source: "console.log('blocked')" });
    expect(pending.permission?.action).toBe("ask");
    expect(pending.record.status).toBe("pending");

    agentRuntimeStore.updateSession(sessionId, { permissionRules: [{ gate: "shell", pattern: "*", action: "allow" }] });
    const executed = await toolRegistry.execute(sessionId, "run", { language: "node", source: "console.log('registered')" });
    expect(executed.record.status).toBe("completed");
    expect(executed.record.outputRef).toMatchObject({ exitCode: 0, stdout: "registered\n", language: "node" });
  }, 20_000);
});

describe("run registry input failures", () => {
  it.each([
    { name: "non-object input", args: null },
    { name: "mixed modes", args: { argv: ["echo"], language: "node", source: "console.log('private source')" } },
    { name: "empty argv", args: { argv: [] } },
    { name: "invalid argv token", args: { argv: ["echo", 42] } },
    { name: "missing language", args: { source: "private source" } },
    { name: "blank source", args: { language: "node", source: " " } },
    { name: "detached shell", args: { language: "sh", source: "sleep 1 &" } },
    { name: "NUL token", args: { argv: ["cat", "\0"] } },
    { name: "invalid timeout", args: { argv: ["echo"], timeoutMs: 0 } },
  ])("returns a correlated failed receipt for $name before permission or execution", async ({ args }) => {
    const execute = stubExecution();
    const options = invocationOptions();
    const sessionStatus = agentRuntimeStore.getSession(sessionId).status;
    const result = await toolRegistry.execute(sessionId, "run", args, options);

    expect(result.record).toMatchObject({
      ...options, sessionId, toolId: "run", category: "shell", mutability: "read",
      status: "failed", inputRef: args, permissionDecisionId: null,
      argsHash: agentRuntimeStore.hashArgs(args),
      outputRef: { error: true, code: "VALIDATION_ERROR" },
    });
    expect(result.record.endedAt).toBeTruthy();
    expect(result.record.error).toContain("Tool input rejected for run");
    expect(result.record.error).not.toContain("private source");
    expect(result.toolResult).toMatchObject({ outcome: "failed", result: result.record.outputRef });
    expect(result.permission).toBeUndefined();
    expect(agentRuntimeStore.listToolCalls(sessionId)).toHaveLength(1);
    expect(agentRuntimeStore.listPermissions(sessionId)).toHaveLength(0);
    expect(agentRuntimeStore.getSession(sessionId).status).toBe(sessionStatus);
    expect(agentRuntimeStore.listEvents(sessionId)).toContainEqual(expect.objectContaining({
      type: "tool_result", payload: expect.objectContaining({
        runId: options.runId, stepId: options.stepId, toolCallId: result.record.id,
        toolId: "run", status: "failed", code: "VALIDATION_ERROR",
      }),
    }));
    expect(execute).not.toHaveBeenCalled();

    const corrected = await toolRegistry.execute(sessionId, "run", { argv: ["echo", "corrected"] });
    expect(corrected.record.status).toBe("pending");
    expect(corrected.permission?.action).toBe("ask");
  });

  it.each(["missing", "cleared", "foreign"])("returns a durable failed receipt for a %s script reference", async (scenario) => {
    const execute = stubExecution();
    const source = "console.log('private cached source')";
    const owner = scenario === "foreign" ? `${sessionId}-foreign` : sessionId;
    const scriptId = scenario === "missing" ? "missing-script" : rememberScript(owner, "node", source).scriptId;
    if (scenario === "cleared") clearSessionScripts(sessionId);
    const args = { scriptId };
    const options = invocationOptions();
    const result = await toolRegistry.execute(sessionId, "run", args, options);
    expect(result.record).toMatchObject({
      ...options, status: "failed", inputRef: args, permissionDecisionId: null,
      outputRef: { error: true, code: "VALIDATION_ERROR", message: expect.stringMatching(/Script not found.*submit the source again/) },
    });
    expect(result.toolResult).toMatchObject({ outcome: "failed", result: result.record.outputRef });
    expect(JSON.stringify(result.record.outputRef)).not.toContain(source);
    expect(agentRuntimeStore.listToolCalls(sessionId)).toHaveLength(1);
    expect(agentRuntimeStore.listPermissions(sessionId)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    await agentRuntimeStore.flushSession(sessionId);
    await agentRuntimeStore.hydrateSession(sessionId, true);
    expect(agentRuntimeStore.getToolCall(sessionId, result.record.id)).toMatchObject({
      ...options, status: "failed", outputRef: result.record.outputRef,
    });
  });
});

describe("run project grant revalidation", () => {
  it.each([
    { name: "argv write risk", args: { argv: ["git", "push"] }, pattern: "write" },
    { name: "argv command pattern", args: { argv: ["git", "push"] }, pattern: "git:push" },
    { name: "sh script", args: { language: "sh", source: "printf harmless" }, pattern: "write" },
    { name: "Python script", args: { language: "python", source: "print('harmless')" }, pattern: "write" },
    { name: "Node script", args: { language: "node", source: "console.log('harmless')" }, pattern: "write" },
  ])("denies an approved $name when a restriction is added before resume", async ({ args, pattern }) => {
    const execute = stubExecution();
    const pending = await toolRegistry.execute(sessionId, "run", args);
    expect(pending.record.status).toBe("pending");
    const approved = permissionPolicy.reply(sessionId, pending.permission!.id, "always");
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [
      { gate: "shell", pattern, action: "deny" },
      { gate: "*", pattern: "*", action: "allow" },
    ] });
    const result = await toolRegistry.resumePending(sessionId, approved);
    expect(result.record).toMatchObject({ id: pending.record.id, status: "denied" });
    expect(result.record.error).toMatch(/explicit permission restriction/);
    expect(agentRuntimeStore.listToolCalls(sessionId)).toHaveLength(1);
    expect((await toolRegistry.resumePending(sessionId, approved)).record.status).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ["git", "diff"] },
    { argv: ["echo", "literal; git push", "$(touch file)"] },
  ])("keeps read argv $argv authorized without interpreting literal shell text", async (args) => {
    const execute = stubExecution();
    const pending = await toolRegistry.execute(sessionId, "run", args);
    const approved = permissionPolicy.reply(sessionId, pending.permission!.id, "always");
    agentRuntimeStore.updateSession(sessionId, { permissionRules: [
      { gate: "shell", pattern: "write", action: "deny" },
    ] });
    const result = await toolRegistry.resumePending(sessionId, approved);
    expect(result.record.status, result.record.error ?? "").toBe("completed");
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ args }));
  });

  it.each([false, true])("binds a cached source before approval and rechecks it after eviction (deny=%s)", async (deny) => {
    const execute = stubExecution();
    const cached = rememberScript(sessionId, "node", "console.log('cached approval')");
    const args = { language: cached.language, source: cached.source };
    const pending = await toolRegistry.execute(sessionId, "run", { scriptId: cached.scriptId });
    expect(pending.record.inputRef).toEqual(args);
    expect(pending.permission?.metadata?.args).toEqual(args);
    const approved = permissionPolicy.reply(sessionId, pending.permission!.id, "always");
    clearSessionScripts(sessionId);
    if (deny) agentRuntimeStore.updateSession(sessionId, { permissionRules: [
      { gate: "shell", pattern: "write", action: "deny" },
    ] });
    const result = await toolRegistry.resumePending(sessionId, approved);
    expect(result.record.status, result.record.error ?? "").toBe(deny ? "denied" : "completed");
    if (deny) expect(execute).not.toHaveBeenCalled();
    else expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ args }));
  });

  it("rechecks restrictions again immediately before execution after sandbox validation", async () => {
    const execute = stubExecution();
    const pending = await toolRegistry.execute(sessionId, "run", { argv: ["git", "push"] });
    const approved = permissionPolicy.reply(sessionId, pending.permission!.id, "always");
    const validate = sandboxPolicy.validateToolArgs.bind(sandboxPolicy);
    vi.spyOn(sandboxPolicy, "validateToolArgs").mockImplementationOnce((...args) => {
      validate(...args);
      agentRuntimeStore.updateSession(sessionId, { permissionRules: [
        { gate: "shell", pattern: "git:push", action: "deny" },
      ] });
    });
    const result = await toolRegistry.resumePending(sessionId, approved);
    expect(result.record.status).toBe("denied");
    expect(result.record.error).toMatch(/explicit permission restriction/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("run argv sandbox approval", () => {
  it.each([false, true])("binds an option-shaped operand's symlink target to one approval (changed=%s)", async (changed) => {
    const execute = stubExecution();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-run-outside-")));
    const link = path.join(root, "--output=secret");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      for (const name of ["approved", "other"]) {
        fs.mkdirSync(path.join(outside, name));
        fs.writeFileSync(path.join(outside, name, "data"), name);
      }
      fs.symlinkSync(path.join(outside, "approved"), link, symlinkType);
      agentRuntimeStore.updateSession(sessionId, { permissionRules: permissionRulesForTier("boundary") });
      const args = { argv: ["cat", "--", "--output=secret/data"] };
      const pending = await toolRegistry.execute(sessionId, "run", args);
      expect(pending.permission).toMatchObject({
        action: "ask", internalGate: "external_path",
        metadata: { approvalPaths: [path.join(outside, "approved", "data")] },
      });
      const approved = permissionPolicy.reply(sessionId, pending.permission!.id, "once");
      if (changed) {
        fs.unlinkSync(link);
        fs.symlinkSync(path.join(outside, "other"), link, symlinkType);
      }
      const result = await toolRegistry.resumePending(sessionId, approved);
      expect(result.record.status, result.record.error ?? "").toBe(changed ? "denied" : "completed");
      if (changed) {
        expect(result.record.error).toMatch(/workspace boundary/);
        expect(execute).not.toHaveBeenCalled();
      } else expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ args }));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
