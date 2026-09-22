import { spawnOwnedProcess } from "../owned-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { runBackgroundShellCommand } from "../tools/exec-async.js";
import { hasBackgroundBashOperator } from "../tools/bash-command-policy.js";
import {
  listSessionBackgroundProcesses,
  stopSessionBackgroundProcess,
  detectServicePorts,
} from "../session-background-processes.js";
import {
  hasBackgroundProcesses,
  prepareOwnedProcess,
  recordOwnedPid,
} from "../process-ownership.js";

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
});
const session = () =>
  agentSessionRuntime.create({
    projectId: "process-test",
    workDir: process.cwd(),
    profileId: "synax",
    prompt: "service test",
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

it("tracks a real service, isolates sessions, and terminates its process tree", async () => {
  const owner = session();
  const other = session();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-service-"));
  const pidFile = path.join(dir, "pids.json");
  const program = `const cp=require('child_process'),fs=require('fs'),http=require('http');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const server=http.createServer((req,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pids:[process.pid,child.pid],port:server.address().port})));`;
  const command = `${quote(process.execPath)} -e ${quote(program)}`;
  const started = await runBackgroundShellCommand(owner.id, command);
  try {
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    const { pids, port } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
      pids: number[];
      port: number;
    };
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "ready",
    );
    const { agentRuntimeRoutes } =
      await import("../../../routes/agent-runtime.js");
    expect(
      (await agentRuntimeRoutes.request(`/sessions/${owner.id}/processes`))
        .status,
    ).toBe(200);
    expect(
      listSessionBackgroundProcesses(owner.id).find(
        (item) => item.id === started.processId,
      ),
    ).toMatchObject({ command, state: "active", pid: started.pid });
    expect(hasBackgroundProcesses(owner.id)).toBe(true);
    expect(listSessionBackgroundProcesses(other.id)).toEqual([]);
    await expect(
      stopSessionBackgroundProcess(other.id, started.processId),
    ).rejects.toMatchObject({ status: 404 });
    expect(alive(started.pid)).toBe(true);
    expect(
      (
        await agentRuntimeRoutes.request(
          `/sessions/${other.id}/processes/${started.processId}/stop`,
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await agentRuntimeRoutes.request(
          `/sessions/${owner.id}/processes/${started.processId}/stop`,
          { method: "POST" },
        )
      ).status,
    ).toBe(200);
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    await vi.waitFor(
      () =>
        expect([started.pid, ...pids].map(alive)).toEqual([
          false,
          false,
          false,
        ]),
      { timeout: 5000 },
    );
    expect(hasBackgroundProcesses(owner.id)).toBe(false);
    expect(
      listSessionBackgroundProcesses(owner.id).find(
        (item) => item.id === started.processId,
      )?.state,
    ).toBe("closed");
    await stopSessionBackgroundProcess(owner.id, started.processId);
  } finally {
    await stopSessionBackgroundProcess(owner.id, started.processId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it("records natural exits and never kills a reused or unrelated PID", async () => {
  const owner = session();
  const started = await runBackgroundShellCommand(owner.id, "printf ready");
  await vi.waitFor(() =>
    expect(
      listSessionBackgroundProcesses(owner.id).find(
        (item) => item.id === started.processId,
      ),
    ).toMatchObject({ state: "closed", exitCode: 0 }),
  );
  const fake = prepareOwnedProcess("not this process", true, {
    sessionId: owner.id,
    background: true,
  });
  recordOwnedPid(fake.id, process.pid);
  await stopSessionBackgroundProcess(owner.id, fake.id);
  expect(alive(process.pid)).toBe(true);
  expect(
    getRawSqlite()
      .prepare("SELECT state FROM agent_runtime_processes WHERE id=?")
      .get(fake.id),
  ).toMatchObject({ state: "closed" });
});

it("tracks conventional ampersand jobs without treating quotes and redirects as background operators", async () => {
  for (const command of [
    'echo "&"',
    "echo '&'",
    "echo hi && echo there",
    "echo hi >&2",
    "echo hi &> log",
    "echo \\&",
  ])
    expect(hasBackgroundBashOperator(command)).toBe(false);
  expect(hasBackgroundBashOperator("node server.js &")).toBe(true);
  const owner = session();
  const started = await runBackgroundShellCommand(
    owner.id,
    `${quote(process.execPath)} -e 'setInterval(()=>{},1000)' &`,
    { waitForJobs: true },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(alive(started.pid)).toBe(true);
    await stopSessionBackgroundProcess(owner.id, started.processId);
  } finally {
    await stopSessionBackgroundProcess(owner.id, started.processId);
  }
});

it.skipIf(process.platform === "win32")(
  "terminates verified descendants even after their launcher has exited",
  async () => {
    const owner = session();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-service-orphan-"));
    const file = path.join(dir, "pid");
    const program = `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
    // An explicitly legacy pipe-based service: new PTYs do not have a separate launcher.
    const child = spawnOwnedProcess(
      `${quote(process.execPath)} -e ${quote(program)}`,
      [],
      { shell: true, background: true, sessionId: owner.id, stdin: "ignore" },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message: any) => {
        if (message.type === "started") resolve();
      });
      child.once("error", reject);
    });
    const started = { processId: child.ownedProcessId, pid: child.pid! };
    try {
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
      const targetPid = Number(fs.readFileSync(file, "utf8"));
      process.kill(started.pid, "SIGKILL");
      await vi.waitFor(() => expect(alive(started.pid)).toBe(false));
      expect(alive(targetPid)).toBe(true);
      await stopSessionBackgroundProcess(owner.id, started.processId);
      await vi.waitFor(() => expect(alive(targetPid)).toBe(false));
    } finally {
      try {
        process.kill(-started.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("only deletes closed service records belonging to the requested session", async () => {
  const owner = session();
  const other = session();
  const { agentRuntimeRoutes } =
    await import("../../../routes/agent-runtime.js");
  const ticket = prepareOwnedProcess("test service", true, {
    sessionId: owner.id,
    background: true,
  });
  const remove = (sessionId: string, id = ticket.id) =>
    agentRuntimeRoutes.request(`/sessions/${sessionId}/processes/${id}`, {
      method: "DELETE",
    });
  expect((await remove(other.id)).status).toBe(404);
  expect((await remove(owner.id)).status).toBe(409);
  expect(listSessionBackgroundProcesses(owner.id)).toHaveLength(1);
  getRawSqlite()
    .prepare("UPDATE agent_runtime_processes SET state='closed' WHERE id=?")
    .run(ticket.id);
  expect((await remove(owner.id)).status).toBe(200);
  expect(listSessionBackgroundProcesses(owner.id)).toEqual([]);
  expect((await remove(owner.id)).status).toBe(404);
  const foreground = prepareOwnedProcess("foreground", true, {
    sessionId: owner.id,
  });
  getRawSqlite()
    .prepare("UPDATE agent_runtime_processes SET state='closed' WHERE id=?")
    .run(foreground.id);
  expect((await remove(owner.id, foreground.id)).status).toBe(404);
});

it("detects service ports from common listen flags while ignoring look-alikes", () => {
  expect(detectServicePorts("npm run dev")).toEqual([]);
  expect(detectServicePorts("vite --port 5173")).toEqual([5173]);
  expect(detectServicePorts("PORT=3000 node server.js")).toEqual([3000]);
  expect(detectServicePorts("next dev -p 4000")).toEqual([4000]);
  expect(detectServicePorts("docker run -p 8080:80 nginx")).toEqual([80, 8080]);
  expect(detectServicePorts("node server.js --host localhost:3000")).toEqual([
    3000,
  ]);
  expect(
    detectServicePorts("python3 -m http.server 8080 --bind 0.0.0.0"),
  ).toEqual([8080]);
  expect(detectServicePorts("curl http://example.com:8080/api")).toEqual([]);
  expect(detectServicePorts("tar -xf site-2024.tar.gz --port=0")).toEqual([]);
  expect(detectServicePorts("vite --port 999999 --mode Important=1")).toEqual(
    [],
  );
});

it("treats plain terminals as deletable while running and never maps ports for them", async () => {
  const owner = session();
  const { agentRuntimeRoutes } =
    await import("../../../routes/agent-runtime.js");
  // A real spawned owned process (no PTY): node-pty is unavailable in some
  // CI sandboxes, but the owned-process launcher carries the same ownership
  // nonce the terminal delete path must verify and stop.
  const child = spawnOwnedProcess(
    `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`,
    [],
    {
      shell: true,
      background: true,
      sessionId: owner.id,
      stdin: "ignore",
      commandLabel: "dev :3000",
    },
  );
  const ticketId = child.ownedProcessId;
  try {
    const db = getRawSqlite();
    db.prepare(
      "UPDATE agent_runtime_processes SET kind='terminal' WHERE id=?",
    ).run(ticketId);
    db.prepare(
      `INSERT INTO terminal_sessions (id,project_id,root_id,owner_session_id,kind,title,cwd,shell,command,cols,rows,request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      ticketId,
      owner.projectId,
      "primary",
      owner.id,
      "terminal",
      // A port-like title must not produce a port mapping.
      "dev :3000",
      os.tmpdir(),
      process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      null,
      100,
      30,
      null,
    );
    child.stdout?.resume();
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message: any) => {
        if (message.type === "started") resolve();
      });
      child.once("error", reject);
    });
    const listed = listSessionBackgroundProcesses(owner.id).find(
      (item) => item.id === ticketId,
    );
    // Manually created terminals are owned by the terminal drawer and are
    // intentionally absent from the background-services list.
    expect(listed).toBeUndefined();
    // Deleting a running terminal must not require stopping it first.
    expect(
      (
        await agentRuntimeRoutes.request(
          `/sessions/${owner.id}/processes/${ticketId}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    expect(
      listSessionBackgroundProcesses(owner.id).find(
        (item) => item.id === ticketId,
      ),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM terminal_sessions WHERE id=?").get(ticketId),
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(child.exitCode === null && child.signalCode === null).toBe(false),
    );
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});
