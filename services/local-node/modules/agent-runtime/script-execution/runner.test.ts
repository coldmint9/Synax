import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "../tools/exec-async.js";
import { MEMORY_COMMAND_MAX_BUFFER_BYTES, runMemoryCommand } from "./runner.js";

// Use the repository's isolated DATA_ROOT/runtime fixtures, never host config.
let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synax-memory-command-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await commands.terminateOwnedCommands();
  fs.rmSync(cwd, { recursive: true, force: true });
});
const timeoutMs = 10_000;
const literalArgs = ["", "two words", "'quoted'\"", "$(touch injected)", "line\nbreak", "中文", "--eval", "back\\slash"];

describe("memory command transport with real interpreters", () => {
  it("executes argv without a shell and preserves every argument and stdin", async () => {
    const spy = vi.spyOn(commands, "runCommand");
    const data = "user input\n\0中文";
    const source = "let text=''; process.stdin.setEncoding('utf8'); for await (const part of process.stdin) text += part; console.log(JSON.stringify({args:process.argv.slice(1),text}));";
    const result = await runMemoryCommand({ cwd, timeoutMs, stdin: data,
      argv: [process.execPath, "--input-type=module", "--eval", source, "--", ...literalArgs] });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({ args: literalArgs, text: data });
    expect(spy).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({ shell: false }));
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("runs Node ESM with top-level await and keeps data separate from source", async () => {
    const onStarted = vi.fn();
    const env = { RUN_MEMORY_VALUE: "child value" };
    const original = process.env.RUN_MEMORY_VALUE;
    const source = `import { readFileSync } from 'node:fs';
      await Promise.resolve();
      console.log(JSON.stringify({args:process.argv.slice(1), input:readFileSync(0,'utf8'), cwd:process.cwd(), value:process.env.RUN_MEMORY_VALUE}));`;
    const result = await runMemoryCommand({ language: "node", source, args: literalArgs,
      stdin: "not javascript\n", cwd, timeoutMs, env, onStarted });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: literalArgs, input: "not javascript\n", cwd: fs.realpathSync(cwd), value: "child value" });
    expect(onStarted).toHaveBeenCalledOnce();
    expect(env).toEqual({ RUN_MEMORY_VALUE: "child value" });
    expect(process.env.RUN_MEMORY_VALUE).toBe(original);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("distinguishes Node ESM parse failures from a runtime SyntaxError", async () => {
    const invalid = await runMemoryCommand({ cwd, timeoutMs, language: "node",
      source: "console.log('must not run'); const invalid = ;" });
    expect(invalid.status).not.toBe(0);
    expect(invalid.syntaxError).toBe(true);
    expect(invalid.stdout).toBe("");
    const runtime = await runMemoryCommand({ cwd, timeoutMs, language: "node",
      source: "throw new SyntaxError('runtime error');" });
    expect(runtime.status).not.toBe(0);
    expect(runtime.syntaxError).toBe(false);
  });

  it("keeps partial stdout and stderr on timeout", async () => {
    const result = await runMemoryCommand({ cwd, timeoutMs: 1500, language: "node",
      source: "console.log('partial stdout'); console.error('partial stderr'); setInterval(() => {}, 1000);" });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("partial stdout");
    expect(result.stderr).toContain("partial stderr");
  }, 15_000);

  it("caps each captured stream at 64 KiB without losing byte counts", async () => {
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "node",
      source: "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000));" });
    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(MEMORY_COMMAND_MAX_BUFFER_BYTES);
    expect(result.stderr).toHaveLength(MEMORY_COMMAND_MAX_BUFFER_BYTES);
    expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true, stdoutBytes: 100000, stderrBytes: 100000 });
  });

  it("returns the shared cancellation result without creating a process when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(commands, "runCommand");
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "node", source: "console.log('never')", signal: controller.signal });
    expect(result.error?.code).toBe("ABORT_ERR");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects oversized source and argv before spawning, without disk fallback", async () => {
    const spy = vi.spyOn(commands, "runCommand");
    await expect(runMemoryCommand({ cwd, timeoutMs, language: "node", source: "文".repeat(100_000) })).rejects.toThrow(/command-line byte limit/);
    await expect(runMemoryCommand({ cwd, timeoutMs, argv: [process.execPath, "x".repeat(300_000)] })).rejects.toThrow(/command-line byte limit/);
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("rejects WSL cwd, ambiguous modes, NUL argv and invalid timeout before spawning", async () => {
    const spy = vi.spyOn(commands, "runCommand");
    await expect(runMemoryCommand({ cwd: "\\\\wsl.localhost\\Ubuntu\\tmp", timeoutMs, argv: ["echo"] })).rejects.toThrow(/legacy bash/);
    await expect(runMemoryCommand({ cwd, timeoutMs, argv: ["echo"], language: "sh", source: "echo" })).rejects.toThrow(/not both/);
    await expect(runMemoryCommand({ cwd, timeoutMs, argv: ["echo", "\0"] })).rejects.toThrow(/NUL/);
    await expect(runMemoryCommand({ cwd, timeoutMs: 0, argv: ["echo"] })).rejects.toThrow(/timeoutMs/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("POSIX sh whole-source preflight", () => {
  it("uses /bin/sh for both phases, exact positional arguments and data-only stdin", async () => {
    const spy = vi.spyOn(commands, "runCommand");
    const onStarted = vi.fn();
    const shellSource = 'printf "%s\\000" "$@"; cat';
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "sh",
      source: shellSource, args: literalArgs, stdin: "user data\n", onStarted });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${literalArgs.join("\0")}\0user data\n`);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe("/bin/sh");
    expect(spy.mock.calls[0][1].slice(0, 3)).toEqual(["-n", "-c", shellSource]);
    expect(spy.mock.calls[0][2]?.stdin).toBeUndefined();
    expect(spy.mock.calls[0][2]?.onStarted).toBeUndefined();
    expect(spy.mock.calls[1][0]).toBe("/bin/sh");
    expect(spy.mock.calls[1][2]?.timeoutMs).toBeLessThanOrEqual(spy.mock.calls[0][2]!.timeoutMs!);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("prevents early side effects when a later line has a syntax error", async () => {
    const onStarted = vi.fn();
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "sh", source: "touch marker\nif then", onStarted });
    expect(result).toMatchObject({ status: 2, syntaxError: true, timedOut: false });
    expect(result.stderr).not.toBe("");
    expect(onStarted).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("does not mislabel an executed script exiting 2 as a syntax error", async () => {
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "sh", source: "printf done; exit 2" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("done");
    expect(result.syntaxError).not.toBe(true);
  });

  it("honors cancellation arriving after real preflight but before execution", async () => {
    const controller = new AbortController();
    const realRunCommand = commands.runCommand;
    const spy = vi.spyOn(commands, "runCommand").mockImplementation(async (...args) => {
      const result = await realRunCommand(...args);
      controller.abort();
      return result;
    });
    const onStarted = vi.fn();
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "sh", source: "touch marker", signal: controller.signal, onStarted });
    expect(result.error?.code).toBe("ABORT_ERR");
    expect(spy).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("uses one total deadline rather than refreshing timeout after preflight", async () => {
    const realRunCommand = commands.runCommand;
    const spy = vi.spyOn(commands, "runCommand").mockImplementation(async (...args) => {
      const result = await realRunCommand(...args);
      expect(result.status).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 1100));
      return result;
    });
    const onStarted = vi.fn();
    const result = await runMemoryCommand({ cwd, timeoutMs: 1000, language: "sh", source: "touch marker", onStarted });
    expect(result).toMatchObject({ timedOut: true, setupTimedOut: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("snapshots arguments and environment across the preflight await", async () => {
    const args = ["original"];
    const env = { RUN_MEMORY_VALUE: "original" };
    const realRunCommand = commands.runCommand;
    vi.spyOn(commands, "runCommand").mockImplementation(async (...call) => {
      const result = await realRunCommand(...call);
      args[0] = "changed";
      env.RUN_MEMORY_VALUE = "changed";
      return result;
    });
    const result = await runMemoryCommand({ cwd, timeoutMs, language: "sh", source: 'printf "%s:%s" "$1" "$RUN_MEMORY_VALUE"', args, env });
    expect(result).toMatchObject({ status: 0, stdout: "original:original" });
  });
});

describe.skipIf(process.platform !== "win32")("Windows explicit limitations", () => {
  it("rejects sh and cmd/bat instead of silently invoking a shell", async () => {
    await expect(runMemoryCommand({ cwd, timeoutMs, language: "sh", source: "echo hello" })).rejects.toThrow(/not supported on Windows/);
    for (const command of ["npm.cmd", "C:\\tools\\SCRIPT.BAT"]) {
      await expect(runMemoryCommand({ cwd, timeoutMs, argv: [command] })).rejects.toThrow(/no shell fallback/);
    }
  });
});
