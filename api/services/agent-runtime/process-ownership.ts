import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getRawSqlite, tryGetRawSqlite } from "../../db/index.js";
import {
  currentExecutionContext,
  withoutExecutionContext,
} from "../../lib/execution-context.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { nowIso } from "./runtime-ids.js";
import { stopWslOwnedProcess } from "../wsl.js";

export interface OwnedProcessRecord {
  id: string;
  host_id: string;
  session_id: string | null;
  run_id: string | null;
  pid: number | null;
  process_group: number;
  state: string;
  command_label: string;
  kind?: string;
  started_at?: string;
  ended_at?: string | null;
  exit_code?: number | null;
  runtime_kind?: "host" | "wsl";
  runtime_distribution?: string | null;
  runtime_pid?: number | null;
  runtime_pgid?: number | null;
}
const INTERNAL_ENV = [
  "AGENT_SESSION_INIT",
  "WIKI_JOB_INIT",
  "SYNAX_AGENT_SESSION_CHILD",
  "SYNAX_WIKI_JOB_CHILD",
  "SYNAX_RUNTIME_HOST_ID",
  "SYNAX_RUNTIME_DATA_ROOT",
  "SYNAX_RECORDED_START",
  "SYNAX_TERMINAL_HOST_ORIGIN",
];

export function externalCommandEnvironment(
  overrides?: NodeJS.ProcessEnv,
  inherit = true,
): NodeJS.ProcessEnv {
  const env = { ...(inherit ? process.env : {}), ...overrides };
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  const internalWorker =
    process.env.SYNAX_AGENT_SESSION_CHILD === "1" ||
    process.env.SYNAX_WIKI_JOB_CHILD === "1";
  if (
    env.DATA_ROOT &&
    ((runtimeRoot &&
      path.resolve(env.DATA_ROOT) === path.resolve(runtimeRoot)) ||
      (internalWorker && env.DATA_ROOT === process.env.DATA_ROOT))
  )
    delete env.DATA_ROOT;
  for (const key of INTERNAL_ENV) delete env[key];
  return env;
}

export function prepareOwnedProcess(
  commandLabel: string,
  grouped: boolean,
  options: { sessionId?: string; background?: boolean } = {},
) {
  const context = currentExecutionContext();
  const ticket = {
    id: randomUUID(),
    hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
  };
  getRawSqlite()
    .prepare(
      `INSERT INTO agent_runtime_processes
    (id, host_id, session_id, run_id, pid, process_group, command_label, state, started_at, kind)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'preparing', ?, ?)`,
    )
    .run(
      ticket.id,
      ticket.hostId,
      context?.sessionId ?? options.sessionId ?? null,
      context?.runId ?? null,
      grouped ? 1 : 0,
      commandLabel,
      nowIso(),
      options.background ? "background" : "command",
    );
  return ticket;
}
export function recordOwnedPid(id: string, pid: number | undefined): void {
  if (!pid) return;
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_processes SET pid=?, state='active' WHERE id=?",
    )
    .run(pid, id);
  emitProcessChange(id);
}
export function recordOwnedRuntimeTarget(
  id: string,
  distribution: string,
): void {
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_processes SET runtime_kind='wsl', runtime_distribution=? WHERE id=?",
    )
    .run(distribution, id);
}

export function recordOwnedRuntime(
  id: string,
  runtime: { kind: "wsl"; distribution: string; pid: number; pgid: number },
): void {
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_processes SET runtime_kind='wsl', runtime_distribution=?, runtime_pid=?, runtime_pgid=? WHERE id=?",
    )
    .run(runtime.distribution, runtime.pid, runtime.pgid, id);
  emitProcessChange(id);
}

export function releaseOwnedProcess(
  id: string,
  exitCode: number | null = null,
): void {
  withoutExecutionContext(() => {
    try {
      tryGetRawSqlite()
        ?.prepare(
          "UPDATE agent_runtime_processes SET state='closed', ended_at=?, exit_code=COALESCE(exit_code, ?) WHERE id=?",
        )
        .run(nowIso(), exitCode, id);
    } catch {
      /* Host recovery can recheck a receipt if shutdown already closed this connection. */
    }
    emitProcessChange(id);
  });
}
function emitProcessChange(id: string): void {
  try {
    const row = tryGetRawSqlite()
      ?.prepare(
        "SELECT session_id, kind FROM agent_runtime_processes WHERE id=?",
      )
      .get(id) as { session_id: string | null; kind: string } | undefined;
    if (row?.session_id && row.kind === "background")
      emitRuntimeBusEvent({
        type: "session_process_changed",
        sessionId: row.session_id,
      });
  } catch {
    /* Process shutdown may race the database closing. */
  }
}

export function hasBackgroundProcesses(
  sessionId: string,
  workerOwnedOnly = false,
): boolean {
  return Boolean(
    getRawSqlite()
      .prepare(
        `SELECT 1 FROM agent_runtime_processes p WHERE session_id=? AND kind='background' AND state<>'closed' ${workerOwnedOnly ? "AND NOT EXISTS (SELECT 1 FROM terminal_sessions t WHERE t.id=p.id)" : ""} LIMIT 1`,
      )
      .get(sessionId),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Interactive shells can rewrite the environment block that macOS ps reads.
 * Bind managed PTYs to PID + kernel birth time + controlling TTY instead. */
export async function readProcessIdentity(
  pid: number,
  expectedTty?: string,
): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const tty = Number(fields[4]) >>> 0;
      if (!tty || !fields[19]) return null;
      if (expectedTty && Number((await fs.stat(expectedTty)).rdev) !== tty)
        return null;
      return `linux:${pid}:${fields[19]}:${tty}`;
    }
    if (process.platform === "darwin") {
      const text = await new Promise<string>((resolve, reject) =>
        execFile(
          "/bin/ps",
          ["-p", String(pid), "-o", "lstart=,tty="],
          {
            timeout: 2000,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
      const fields = text.trim().split(/\s+/);
      const tty = fields[fields.length - 1];
      if (
        fields.length < 6 ||
        !tty ||
        tty === "??" ||
        (expectedTty && path.basename(expectedTty) !== tty)
      )
        return null;
      return `darwin:${pid}:${fields.join(" ")}`;
    }
  } catch {
    /* A missing or uninspectable process does not authorize a signal. */
  }
  return null;
}
async function terminalIdentityStatus(
  record: OwnedProcessRecord,
): Promise<"owned" | "different" | "unknown" | undefined> {
  if (!record.pid) return undefined;
  try {
    const row = tryGetRawSqlite()
      ?.prepare("SELECT process_identity FROM terminal_sessions WHERE id=?")
      .get(record.id) as { process_identity: string | null } | undefined;
    if (!row) return undefined;
    if (!row.process_identity) return "unknown";
    const actual = await readProcessIdentity(record.pid);
    return actual
      ? actual === row.process_identity
        ? "owned"
        : "different"
      : "unknown";
  } catch {
    return undefined;
  }
}
async function markerStatus(
  record: OwnedProcessRecord,
): Promise<"owned" | "gone" | "different" | "unknown"> {
  if (!record.pid || !alive(record.pid)) return "gone";
  try {
    if (process.platform === "linux") {
      const entries = (
        await fs.readFile(`/proc/${record.pid}/environ`, "utf8")
      ).split("\0");
      return entries.includes(`SYNAX_PROCESS_OWNER=${record.id}`)
        ? "owned"
        : ((await terminalIdentityStatus(record)) ?? "different");
    }
    if (process.platform === "darwin") {
      const text = await new Promise<string>((resolve, reject) =>
        execFile(
          "/bin/ps",
          ["eww", "-p", String(record.pid), "-o", "command="],
          { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
      // Process environments may contain credentials: inspect the nonce only, never return or log this text.
      return new RegExp(
        `(?:^|\\s)SYNAX_PROCESS_OWNER=${record.id}(?:\\s|$)`,
      ).test(text)
        ? "owned"
        : ((await terminalIdentityStatus(record)) ?? "different");
    }
    return "unknown";
  } catch {
    return alive(record.pid)
      ? ((await terminalIdentityStatus(record)) ?? "unknown")
      : "gone";
  }
}

async function hasOwnedGroupMember(
  record: OwnedProcessRecord,
): Promise<boolean> {
  try {
    const text = await new Promise<string>((resolve, reject) =>
      execFile(
        "/bin/ps",
        ["-axo", "pid=,pgid="],
        { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    const deadline = Date.now() + 2000;
    for (const line of text.trim().split(/\r?\n/)) {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      if (group !== record.pid || pid === record.pid || !pid) continue;
      if (Date.now() > deadline) break;
      if (
        (await markerStatus({ ...record, pid, process_group: 0 })) === "owned"
      )
        return true;
    }
  } catch {
    /* Unknown group ownership must not authorize a signal. */
  }
  return false;
}

export async function stopRecordedProcess(
  record: OwnedProcessRecord,
): Promise<boolean> {
  if (record.runtime_kind === "wsl" && record.runtime_distribution) {
    const stopped = await stopWslOwnedProcess(
      record.runtime_distribution,
      record.id,
      record.runtime_pid,
      record.runtime_pgid,
    );
    if (!stopped) return false;
    try {
      if (record.pid) process.kill(record.pid, "SIGKILL");
    } catch {}
    releaseOwnedProcess(record.id);
    return true;
  }
  let status = await markerStatus(record);
  if (status === "different") {
    releaseOwnedProcess(record.id);
    return true;
  }
  if (status === "gone") {
    if (
      record.process_group &&
      process.platform !== "win32" &&
      record.pid &&
      alive(-record.pid)
    ) {
      // A dead launcher does not prove that its descendants have stopped.
      if (!(await hasOwnedGroupMember(record))) return false;
      status = "owned";
    } else {
      releaseOwnedProcess(record.id);
      return true;
    }
  }
  if (status !== "owned" || !record.pid) return false;
  const target =
    record.process_group && process.platform !== "win32"
      ? -record.pid
      : record.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  const start = Date.now();
  let forced = false;
  while (true) {
    let live = false;
    try {
      process.kill(target, 0);
      live = true;
    } catch (error) {
      live = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (!live) {
      releaseOwnedProcess(record.id);
      return true;
    }
    if (!forced && Date.now() - start > 1500) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
      forced = true;
    }
    if (Date.now() - start > 4000) return false;
    await delay(25);
  }
}

export async function recoverOwnedProcesses(
  hostId: string,
): Promise<OwnedProcessRecord[]> {
  const records = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_processes WHERE host_id <> ? AND state <> 'closed'",
    )
    .all(hostId) as OwnedProcessRecord[];
  const unresolved: OwnedProcessRecord[] = [];
  for (const record of records.reverse()) {
    if (!(await stopRecordedProcess(record))) {
      getRawSqlite()
        .prepare(
          "UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?",
        )
        .run(record.id);
      unresolved.push(record);
    }
  }
  return unresolved;
}

export async function stopHostProcesses(
  hostId: string,
): Promise<OwnedProcessRecord[]> {
  const records = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_processes WHERE host_id=? AND state<>'closed'",
    )
    .all(hostId) as OwnedProcessRecord[];
  const unresolved: OwnedProcessRecord[] = [];
  for (const record of records.reverse())
    if (!(await stopRecordedProcess(record))) unresolved.push(record);
  return unresolved;
}
