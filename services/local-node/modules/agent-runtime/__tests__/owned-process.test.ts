import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnOwnedProcess } from "../owned-process.js";
import { runCommand, runShellCommand } from "../tools/exec-async.js";

const leases = vi.hoisted(() => ({ wait: vi.fn(async (_id: string) => {}) }));
vi.mock("../process-ownership.js", async (original) => ({
  ...await original<typeof import("../process-ownership.js")>(),
  waitForAuthoritativeLease: leases.wait,
}));

const children: ChildProcess[] = [];
const directories: string[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-owned-"));
  directories.push(dir);
  return dir;
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" })
    .trim().split("\n").map((line) => {
      const [, pid, parent, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)!;
      return { pid: Number(pid), parent: Number(parent), command };
    });
}
function owned(command: string, args: string[], options = {}) {
  const child = spawnOwnedProcess(command, args, options);
  children.push(child);
  return child;
}

beforeEach(() => leases.wait.mockResolvedValue(undefined));
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const closed = once(child, "close");
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    await closed;
  }));
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("shared POSIX command supervision", () => {
  it("runs 24 concurrent targets with one guardian and no per-command Node launchers", async () => {
    const targets = Array.from({ length: 24 }, () => owned("/bin/sh", ["-c", "echo ready; exec sleep 30"]));
    await Promise.all(targets.map((child) => once(child.stdout!, "data")));
    const table = processes();
    const hosts = table.filter((entry) => entry.parent === process.pid);
    expect(hosts.filter((entry) => entry.command.includes("process-guardian.cjs"))).toHaveLength(1);
    expect(hosts.filter((entry) => entry.command.includes("owned-process-runner.cjs"))).toHaveLength(0);
    for (const child of targets) {
      expect(table.find((entry) => entry.pid === child.pid)?.command).toMatch(/sleep 30$/);
    }
  });

  it("waits for the authoritative lease before allowing any command side effect", async () => {
    let release!: () => void;
    leases.wait.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const cwd = directory();
    const child = owned("/bin/sh", ["-c", "echo ran > marker"], { cwd });
    const closed = once(child, "close");
    await pause(100);
    expect(fs.existsSync(path.join(cwd, "marker"))).toBe(false);
    release();
    await closed;
    expect(fs.readFileSync(path.join(cwd, "marker"), "utf8").trim()).toBe("ran");
  });

  it("does not run a command when registration is rejected", async () => {
    leases.wait.mockRejectedValueOnce(new Error("lease rejected"));
    const cwd = directory();
    const child = owned("/bin/sh", ["-c", "echo escaped > marker"], { cwd });
    await once(child, "close");
    expect(fs.existsSync(path.join(cwd, "marker"))).toBe(false);
  });

  it("does not start a cancelled command when its delayed lease later arrives", async () => {
    let release!: () => void;
    leases.wait.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const cwd = directory();
    const child = owned("/bin/sh", ["-c", "echo escaped > marker"], { cwd });
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    release();
    await pause(30);
    expect(fs.existsSync(path.join(cwd, "marker"))).toBe(false);
  });

  it("preserves literal argv, cwd, stdin, environment and exit status", async () => {
    const cwd = directory();
    const args = ["two words", "$(touch escaped)", "'quoted'", "line\nbreak", ""];
    const result = await runCommand(process.execPath, ["-e", `
      let input = ''; process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), input, env: process.env.SYNAX_TEST_VALUE }));
        process.exit(7);
      });
    `, ...args], { cwd, stdin: "input\n\0bytes", env: { SYNAX_TEST_VALUE: "literal value" }, inheritEnv: false });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: fs.realpathSync(cwd), input: "input\n\0bytes", env: "literal value" });
    expect(fs.existsSync(path.join(cwd, "escaped"))).toBe(false);
  });

  it("kills timeout descendants and reaps descendants after their command exits", async () => {
    const cwd = directory();
    const timeout = await runShellCommand("echo $$ > pid; trap '' TERM; sleep 20", { cwd, timeoutMs: 150 });
    expect(timeout.timedOut).toBe(true);
    expect(alive(Number(fs.readFileSync(path.join(cwd, "pid"), "utf8")))).toBe(false);
    const done = await runShellCommand("sleep 20 </dev/null >/dev/null 2>&1 & echo $!", { cwd });
    expect(done.status).toBe(0);
    await vi.waitFor(() => expect(alive(Number(done.stdout.trim()))).toBe(false), { timeout: 4000 });
  });

  it("reaps command groups after the host is killed and then exits the guardian", async () => {
    const cwd = directory();
    const script = path.join(cwd, "host.mts");
    const module = pathToFileURL(path.resolve("services/local-node/modules/agent-runtime/owned-process.ts")).href;
    fs.writeFileSync(script, `import {spawnOwnedProcess} from ${JSON.stringify(module)};
      const child = spawnOwnedProcess('/bin/sh', ['-c', 'trap "" TERM; echo $$ > pid; sleep 30'], {cwd:${JSON.stringify(cwd)}});
      child.stdout.resume(); child.stderr.resume();
    `);
    const host = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore", detached: true });
    children.push(host);
    await vi.waitFor(() => expect(fs.existsSync(path.join(cwd, "pid"))).toBe(true), { timeout: 5000 });
    const targetPid = Number(fs.readFileSync(path.join(cwd, "pid"), "utf8"));
    const guardianPid = processes().find((entry) => entry.parent === host.pid && entry.command.includes("process-guardian.cjs"))!.pid;
    const closed = once(host, "close");
    host.kill("SIGKILL");
    await closed;
    await vi.waitFor(() => {
      expect(alive(targetPid)).toBe(false);
      expect(alive(guardianPid)).toBe(false);
    }, { timeout: 5000 });
  }, 10000);

  it("fails closed if the guardian crashes and creates one replacement for later commands", async () => {
    const child = owned("/bin/sh", ["-c", "echo ready; exec sleep 30"]);
    await once(child.stdout!, "data");
    const guardianPid = processes().find((entry) => entry.parent === process.pid && entry.command.includes("process-guardian.cjs"))!.pid;
    const closed = once(child, "close");
    process.kill(guardianPid, "SIGKILL");
    await closed;
    expect(alive(child.pid!)).toBe(false);
    const replacement = owned("/bin/sh", ["-c", "echo ready; exec sleep 30"]);
    await once(replacement.stdout!, "data");
    const guardians = processes().filter((entry) => entry.parent === process.pid && entry.command.includes("process-guardian.cjs"));
    expect(guardians).toHaveLength(1);
    expect(guardians[0].pid).not.toBe(guardianPid);
  });
});
