import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { terminalManager } from "../terminal-manager.js";
import { getRawSqlite } from "../../database/index.js";
import { runtimeFacade } from "../../../modules/agent-runtime/sidecar/runtime-facade.js";

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synax-pty-test-"));
});
afterEach(async () => {
  await terminalManager.shutdown();
  fs.rmSync(cwd, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const start = () =>
  terminalManager.create({
    projectId: "pty-test",
    rootId: "primary",
    cwd,
    kind: "terminal",
    title: "Test shell",
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    shellArgs: process.platform === "win32" ? [] : ["-i"],
    env: { HOME: cwd, PS1: "synax> " },
    cols: 100,
    rows: 30,
  });

it.skipIf(process.platform === "win32")(
  "runs a real TTY, supports input, resize and Ctrl+C without replacing the shell",
  async () => {
    const item = await start();
    terminalManager.write(
      item.id,
      "test -t 0 && printf '\\nTTY_%s\\n' OK; stty size\r",
      randomUUID(),
    );
    await vi.waitFor(() =>
      expect(terminalManager.snapshot(item.id).data).toContain("TTY_OK"),
    );
    expect(terminalManager.snapshot(item.id).data).toContain("30 100");
    terminalManager.resize(item.id, 87, 19);
    terminalManager.write(item.id, "stty size\r", randomUUID());
    await vi.waitFor(() =>
      expect(terminalManager.snapshot(item.id).data).toContain("19 87"),
    );
    terminalManager.write(item.id, "sleep 60\r", randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 120));
    terminalManager.write(item.id, "\x03", randomUUID());
    terminalManager.write(
      item.id,
      "printf '\\nAFTER_%s\\n' INTERRUPT\r",
      randomUUID(),
    );
    await vi.waitFor(() =>
      expect(terminalManager.snapshot(item.id).data).toContain(
        "AFTER_INTERRUPT",
      ),
    );
    expect(terminalManager.get(item.id).pid).toBe(item.pid);
    expect(alive(item.pid!)).toBe(true);
  },
);

it("retains output while detached, deduplicates retried input and rejects cross-project access", async () => {
  const item = await start();
  const request = randomUUID();
  const input =
    process.platform === "win32"
      ? "echo unique > marker.txt\r"
      : "printf unique >> marker.txt\r";
  terminalManager.write(item.id, input, request);
  terminalManager.write(item.id, input, request);
  await vi.waitFor(() =>
    expect(fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").trim()).toBe(
      "unique",
    ),
  );
  expect(() => terminalManager.get(item.id, "another-project")).toThrow();
  const seq = terminalManager.snapshot(item.id).sequence;
  expect(terminalManager.replay(item.id, seq).frames).toEqual([]);
  await terminalManager.stop(item.id);
  expect(terminalManager.get(item.id).state).toBe("closed");
  expect(terminalManager.snapshot(item.id).data.length).toBeGreaterThan(0);
  expect(() =>
    terminalManager.write(item.id, "echo bad\r", randomUUID()),
  ).toThrow();
  terminalManager.remove(item.id);
  expect(() => terminalManager.get(item.id)).toThrow();
  expect(
    getRawSqlite()
      .prepare("SELECT id FROM agent_runtime_processes WHERE id=?")
      .get(item.id),
  ).toBeUndefined();
});

it("uses live Rust-owned terminal metadata without creating SQLite process rows", async () => {
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_STREAM", "authoritative");
  const db = getRawSqlite();
  const prepare = vi.spyOn(db, "prepare");
  const item = await start();
  expect(terminalManager.get(item.id)).toMatchObject({ id: item.id, projectId: "pty-test", state: "active" });
  expect(terminalManager.list("pty-test").some((terminal) => terminal.id === item.id)).toBe(true);
  await terminalManager.stop(item.id);
  expect(terminalManager.get(item.id).state).toBe("closed");
  expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("agent_runtime_processes"));
  vi.unstubAllEnvs();
});

it("hydrates closed metadata and bounded output from Rust after a Node restart", async () => {
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_STREAM", "authoritative");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SOCKET", "mock-sidecar.sock");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "mock-token");
  const terminal = {
    id: "rust-closed-terminal",
    projectId: "rust-restart-project",
    rootId: "primary",
    ownerSessionId: null,
    kind: "service",
    title: "persisted service",
    cwd,
    shell: "/bin/sh",
    command: "printf persisted",
    pid: null,
    state: "closed",
    exitCode: 0,
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:00:01.000Z",
    cols: 100,
    rows: 30,
    outputTail: "persisted output",
    outputSequence: 7,
  };
  const history = vi.spyOn(runtimeFacade, "listTerminalHistory").mockResolvedValue([terminal]);
  try {
    expect(await terminalManager.getAuthoritative(terminal.id, terminal.projectId)).toMatchObject({
      id: terminal.id,
      state: "closed",
      title: terminal.title,
    });
    expect(await terminalManager.listAuthoritative(terminal.projectId)).toEqual([
      expect.objectContaining({ id: terminal.id, state: "closed" }),
    ]);
    expect(await terminalManager.snapshotAuthoritative(terminal.id, terminal.projectId)).toEqual({
      sequence: 7,
      data: "persisted output",
    });
    expect(await terminalManager.replayAuthoritative(terminal.id, terminal.projectId, 0)).toEqual({
      reset: true,
      sequence: 7,
      frames: [{ sequence: 7, data: "persisted output" }],
    });
    expect(history).toHaveBeenCalledTimes(1);
    expect(getRawSqlite().prepare("SELECT id FROM terminal_sessions WHERE id=?").get(terminal.id)).toBeUndefined();
    expect(getRawSqlite().prepare("SELECT id FROM agent_runtime_processes WHERE id=?").get(terminal.id)).toBeUndefined();
  } finally {
    history.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32")(
  "captures background-service output, exit status, and terminates its descendants",
  async () => {
    const ended = await terminalManager.create({
      projectId: "pty-test",
      rootId: "primary",
      cwd,
      kind: "service",
      title: "short",
      command: "printf 'service-output'; exit 7",
    });
    await vi.waitFor(() =>
      expect(terminalManager.get(ended.id)).toMatchObject({
        state: "closed",
        exitCode: 7,
      }),
    );
    expect(terminalManager.snapshot(ended.id).data).toContain("service-output");
    const script = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`;
    fs.writeFileSync(path.join(cwd, "server.cjs"), script);
    const running = await terminalManager.create({
      projectId: "pty-test",
      rootId: "primary",
      cwd,
      kind: "service",
      title: "tree",
      command: `${JSON.stringify(process.execPath)} server.cjs`,
    });
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(cwd, "pids.json"))).toBe(true),
    );
    const children = JSON.parse(
      fs.readFileSync(path.join(cwd, "pids.json"), "utf8"),
    ) as number[];
    await terminalManager.stop(running.id);
    await vi.waitFor(() => expect(children.map(alive)).toEqual([false, false]));
  },
);

it.skipIf(process.platform === 'win32')('bounds retained output and resumes a paused writer when its reader detaches', async () => {
  const item = await start();
  const stale = terminalManager.connectReader(item.id, 'reader-test');
  const disconnect = terminalManager.connectReader(item.id, 'reader-test');
  stale(); // A replaced connection must not unregister its replacement.
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(700000));console.log("FLOW_"+"COMPLETE")'\r`;
  terminalManager.write(item.id, command, randomUUID());
  await vi.waitFor(() => expect(terminalManager.snapshot(item.id).data.length).toBeGreaterThan(256 * 1024));
  expect(terminalManager.snapshot(item.id).data).not.toContain('FLOW_COMPLETE');
  disconnect();
  await vi.waitFor(() => expect(terminalManager.snapshot(item.id).data).toContain('FLOW_COMPLETE'));
  expect(terminalManager.snapshot(item.id).data.length).toBeLessThanOrEqual(1024 * 1024);
});
