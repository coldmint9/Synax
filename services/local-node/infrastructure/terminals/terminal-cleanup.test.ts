import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalManager } from "./terminal-manager.js";
import { runCommand } from "../../modules/agent-runtime/tools/exec-async.js";

const directories: string[] = [];
const pids: number[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

beforeEach(() => {
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_STREAM", "authoritative");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SOCKET", "");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "");
});
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await terminalManager.shutdown();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32")("authoritative terminal cleanup", () => {
  it.each(["stop", "exit"])("cleans a service's separate process groups before reporting completion (%s)", async (reason) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synax-terminal-cleanup-"));
    directories.push(cwd);
    const worker = path.join(cwd, "worker.cjs");
    const parent = path.join(cwd, "parent.cjs");
    fs.writeFileSync(worker, `
      process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});
      require('node:fs').writeFileSync(${JSON.stringify(path.join(cwd, "pid"))}, String(process.pid));
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    fs.writeFileSync(parent, `
      const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.once('message', () => { if (${reason === "exit"}) process.exit(7); });
      setInterval(() => {}, 1000);
    `);
    const terminal = await terminalManager.create({
      projectId: "cleanup-test", rootId: "primary", cwd, kind: "service", title: "build probe",
      shell: "/bin/sh", shellArgs: ["-c", `${quote(process.execPath)} ${quote(parent)}`],
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(cwd, "pid"))).toBe(true));
    const pid = Number(fs.readFileSync(path.join(cwd, "pid"), "utf8"));
    pids.push(pid);
    if (reason === "stop") await terminalManager.stop(terminal.id);
    else await vi.waitFor(() => expect(terminalManager.get(terminal.id).state).toBe("closed"), { timeout: 5000 });
    expect(terminalManager.get(terminal.id).state).toBe("closed");
    if (reason === "exit") expect(terminalManager.get(terminal.id).exitCode).toBe(7);
    expect(alive(pid)).toBe(false);
  }, 10000);

  it("preserves an explicitly started service when a separate foreground command completes", async () => {
    const terminal = await terminalManager.create({
      projectId: "cleanup-test", rootId: "primary", cwd: os.tmpdir(), kind: "service", title: "keep running",
      shell: "/bin/sh", shellArgs: ["-c", "exec sleep 30"],
    });
    expect((await runCommand(process.execPath, ["-e", "console.log('done')"])).status).toBe(0);
    expect(terminalManager.get(terminal.id).state).toBe("active");
    expect(alive(terminal.pid!)).toBe(true);
    await terminalManager.stop(terminal.id);
    expect(alive(terminal.pid!)).toBe(false);
  });
});
