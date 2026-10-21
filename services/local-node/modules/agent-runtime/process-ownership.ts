import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentExecutionContext,
  withoutExecutionContext,
} from "../../infrastructure/runtime/execution-context.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { nowIso } from "./runtime-ids.js";
import { stopWslOwnedProcess } from "../../infrastructure/wsl/wsl.js";

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
  process_identity?: string | null;
}
const INTERNAL_ENV = [
  "AGENT_SESSION_INIT",
  "SYNAX_AGENT_SESSION_CHILD",
  "SYNAX_RUNTIME_HOST_ID",
  "SYNAX_RUNTIME_DATA_ROOT",
  "SYNAX_RECORDED_START",
  "SYNAX_TERMINAL_HOST_ORIGIN",
];

// Authoritative hosts keep the live process identity in Rust control state.
// This in-memory map only bridges synchronous launcher callbacks to the async
// Rust control command; it is never used as a recovery authority.
const authoritativeLeases = new Map<string, OwnedProcessRecord>();
const locallyClosedSessions = new Set<string>();
export function hasLocalBackgroundProcesses(sessionId: string): boolean {
  for (const record of authoritativeLeases.values())
    if (record.session_id === sessionId && record.kind === "background" && record.state !== "closed")
      return true;
  return false;
}
const authoritativeLeaseWrites = new Map<string, Promise<void>>();
type LeaseMirrorRecord = {
  id: string;
  sessionId?: string | null;
  runId?: string | null;
  pid?: number | null;
  processGroup?: number;
  runtimeKind?: string;
  runtimeDistribution?: string | null;
  runtimePid?: number | null;
  runtimePgid?: number | null;
  state?: string;
  commandLabel?: string;
  kind?: string;
  workerOwned?: boolean;
};
type LeaseMirrorRequest = {
  operation: "lease_open" | "lease_close";
  record: LeaseMirrorRecord;
};
const pendingLeaseMirrors = new Map<string, LeaseMirrorRequest>();
const leaseMirrorWorkers = new Map<string, Promise<void>>();
const appliedLeaseMirrorFingerprints = new Map<string, string>();

function leaseMirrorFingerprint(request: LeaseMirrorRequest): string {
  return JSON.stringify([request.operation, request.record]);
}

function startLeaseMirrorWorker(id: string): Promise<void> {
  const existing = leaseMirrorWorkers.get(id);
  if (existing) return existing;
  // Launcher callbacks can report the same lease several times in quick
  // succession (prepare, pid, runtime target, close). Keep only the latest
  // state while one authoritative write is in flight.
  const worker = (async () => {
    while (true) {
      const request = pendingLeaseMirrors.get(id);
      if (!request) return;
      pendingLeaseMirrors.delete(id);
      const fingerprint = leaseMirrorFingerprint(request);
      if (appliedLeaseMirrorFingerprints.get(id) === fingerprint) continue;
      const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
      await runtimeFacade.controlCommand({
        sessionId: request.record.sessionId!,
        requestId: `lease:${request.record.id}:${request.operation}:${request.record.pid ?? "none"}`,
        operation: request.operation,
        payload: {
          leaseId: request.record.id,
          hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
          runId: request.record.runId,
          pid: request.record.pid,
          processGroup: request.record.processGroup ?? 0,
          runtimeKind: request.record.runtimeKind,
          runtimeDistribution: request.record.runtimeDistribution,
          runtimePid: request.record.runtimePid,
          runtimePgid: request.record.runtimePgid,
          state: request.record.state,
          commandLabel: request.record.commandLabel,
          kind: request.record.kind,
          workerOwned: request.record.workerOwned,
        },
      });
      appliedLeaseMirrorFingerprints.set(id, fingerprint);
    }
  })();
  leaseMirrorWorkers.set(id, worker);
  void worker.then(() => {
    if (leaseMirrorWorkers.get(id) !== worker) return;
    leaseMirrorWorkers.delete(id);
    if (pendingLeaseMirrors.has(id)) {
      const next = startLeaseMirrorWorker(id);
      authoritativeLeaseWrites.set(id, next);
    }
  }, () => {
    if (leaseMirrorWorkers.get(id) !== worker) return;
    leaseMirrorWorkers.delete(id);
    if (pendingLeaseMirrors.has(id)) {
      const next = startLeaseMirrorWorker(id);
      authoritativeLeaseWrites.set(id, next);
    }
  });
  return worker;
}

function mirrorProcessLease(
  operation: "lease_open" | "lease_close",
  record: LeaseMirrorRecord,
): Promise<void> {
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM !== "authoritative" || !record.sessionId) return Promise.resolve();
  const request: LeaseMirrorRequest = { operation, record: { ...record } };
  const fingerprint = leaseMirrorFingerprint(request);
  const pending = pendingLeaseMirrors.get(record.id);
  if (pending && leaseMirrorFingerprint(pending) === fingerprint)
    return authoritativeLeaseWrites.get(record.id) ?? Promise.resolve();
  if (appliedLeaseMirrorFingerprints.get(record.id) === fingerprint && !pendingLeaseMirrors.has(record.id))
    return Promise.resolve();
  pendingLeaseMirrors.set(record.id, request);
  const result = startLeaseMirrorWorker(record.id);
  authoritativeLeaseWrites.set(record.id, result);
  void result.then(() => {
    if (authoritativeLeaseWrites.get(record.id) === result && !pendingLeaseMirrors.has(record.id)) authoritativeLeaseWrites.delete(record.id);
  }, () => {
    if (authoritativeLeaseWrites.get(record.id) === result) authoritativeLeaseWrites.delete(record.id);
  });
  return result;
}

export function externalCommandEnvironment(
  overrides?: NodeJS.ProcessEnv,
  inherit = true,
): NodeJS.ProcessEnv {
  const env = { ...(inherit ? process.env : {}), ...overrides };
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  const internalWorker =
    process.env.SYNAX_AGENT_SESSION_CHILD === "1";
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
  const record: OwnedProcessRecord = {
    id: ticket.id,
    host_id: ticket.hostId,
    session_id: context?.sessionId ?? options.sessionId ?? null,
    run_id: context?.runId ?? null,
    pid: null,
    process_group: grouped ? 1 : 0,
    command_label: commandLabel,
    state: "preparing",
    kind: options.background ? "background" : "command",
    started_at: nowIso(),
  };
  {
    authoritativeLeases.set(ticket.id, record);
    if (record.session_id) locallyClosedSessions.delete(record.session_id);
    void mirrorProcessLease("lease_open", { id: record.id, sessionId: record.session_id, runId: record.run_id, processGroup: record.process_group, state: record.state, commandLabel, kind: record.kind, workerOwned: process.env.SYNAX_AGENT_SESSION_CHILD === "1" }).catch(() => {});
    return ticket;
  }
}
export function recordOwnedPid(id: string, pid: number | undefined): void {
  if (!pid) return;
  {
    const record = authoritativeLeases.get(id);
    if (!record) return;
    record.pid = pid;
    record.state = "active";
    void mirrorProcessLease("lease_open", { id, sessionId: record.session_id, runId: record.run_id, pid, processGroup: record.process_group, state: record.state, commandLabel: record.command_label, kind: record.kind, workerOwned: process.env.SYNAX_AGENT_SESSION_CHILD === "1" }).catch(() => {});
    return;
  }
}
export function recordOwnedRuntimeTarget(
  id: string,
  distribution: string,
): void {
  {
    const record = authoritativeLeases.get(id);
    if (record) {
      record.runtime_kind = "wsl";
      record.runtime_distribution = distribution;
      void mirrorProcessLease("lease_open", { id, sessionId: record.session_id, runId: record.run_id, pid: record.pid, processGroup: record.process_group, runtimeKind: "wsl", runtimeDistribution: distribution, state: record.state, commandLabel: record.command_label, kind: record.kind, workerOwned: process.env.SYNAX_AGENT_SESSION_CHILD === "1" }).catch(() => {});
    }
    return;
  }
}

export function recordOwnedRuntime(
  id: string,
  runtime: { kind: "wsl"; distribution: string; pid: number; pgid: number },
): void {
  {
    const record = authoritativeLeases.get(id);
    if (record) {
      record.runtime_kind = "wsl";
      record.runtime_distribution = runtime.distribution;
      record.runtime_pid = runtime.pid;
      record.runtime_pgid = runtime.pgid;
      void mirrorProcessLease("lease_open", { id, sessionId: record.session_id, runId: record.run_id, pid: record.pid, processGroup: record.process_group, runtimeKind: "wsl", runtimeDistribution: runtime.distribution, runtimePid: runtime.pid, runtimePgid: runtime.pgid, state: record.state, commandLabel: record.command_label, kind: record.kind, workerOwned: process.env.SYNAX_AGENT_SESSION_CHILD === "1" }).catch(() => {});
    }
    return;
  }
}

export function releaseOwnedProcess(
  id: string,
  exitCode: number | null = null,
): void {
  {
    const record = authoritativeLeases.get(id);
    if (record) {
      authoritativeLeases.delete(id);
      if (record.session_id && record.kind === "background") {
        const stillOpen = [...authoritativeLeases.values()].some(
          (item) => item.session_id === record.session_id && item.kind === "background" && item.state !== "closed",
        );
        if (!stillOpen) locallyClosedSessions.add(record.session_id);
      }
      void mirrorProcessLease("lease_close", { id, sessionId: record.session_id, runId: record.run_id, pid: record.pid, processGroup: record.process_group, state: "closed", commandLabel: record.command_label, kind: record.kind, workerOwned: process.env.SYNAX_AGENT_SESSION_CHILD === "1" }).catch(() => {});
    }
    return;
  }
}

/** Register a lease discovered from Rust before attempting process cleanup. */
export function registerAuthoritativeLease(record: OwnedProcessRecord): void {
  authoritativeLeases.set(record.id, record);
}

export async function waitForAuthoritativeLease(id: string): Promise<void> {

  await authoritativeLeaseWrites.get(id);
}
function emitProcessChange(id:string):void {
  const record=authoritativeLeases.get(id);
  if(record?.session_id && record.kind==='background') emitRuntimeBusEvent({type:'session_process_changed',sessionId:record.session_id});
}

export async function hasBackgroundProcesses(sessionId: string, workerOwnedOnly = false): Promise<boolean> {
  // Launcher callbacks are synchronous; use the local lease map first so a
  // just-opened service keeps its worker alive before the Rust mirror catches
  // up. A closed local lease must immediately release the child as well.
  if (hasLocalBackgroundProcesses(sessionId)) return true;
  if (locallyClosedSessions.has(sessionId)) return false;
  if (!process.env.SYNAX_RUNTIME_SIDECAR_SOCKET || !process.env.SYNAX_RUNTIME_SIDECAR_TOKEN)
    return false;
  const { runtimeFacade } = await import('./sidecar/runtime-facade.js');
  const state = await runtimeFacade.controlState(sessionId) as { processLeases: Array<{kind?:string;state?:string;workerOwned?:boolean}> };
  return state.processLeases.some(lease=>lease.kind==='background'&&lease.state!=='closed'&&(!workerOwnedOnly||lease.workerOwned===true));
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
async function terminalIdentityStatus(record:OwnedProcessRecord):Promise<'owned'|'different'|'unknown'|undefined> {
  if(!record.pid || !record.process_identity) return undefined;
  const actual=await readProcessIdentity(record.pid);
  return actual ? actual===record.process_identity ? 'owned':'different':'unknown';
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

export async function stopHostProcesses(
  hostId: string,
): Promise<OwnedProcessRecord[]> {
  {
    const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
    const projections = await runtimeFacade.listSessionProjection();
    const unresolved: OwnedProcessRecord[] = [];
    for (const item of projections) {
      const sessionId = (item as { id?: unknown }).id;
      if (typeof sessionId !== "string") continue;
      const state = await runtimeFacade.controlState(sessionId) as { processLeases?: unknown[] };
      for (const raw of Array.isArray(state.processLeases) ? state.processLeases : []) {
        if (!raw || typeof raw !== "object") continue;
        const lease = raw as Record<string, unknown>;
        if (lease.hostId !== hostId || typeof lease.leaseId !== "string") continue;
        const record: OwnedProcessRecord = {
          id: lease.leaseId,
          host_id: hostId,
          session_id: sessionId,
          run_id: typeof lease.runId === "string" ? lease.runId : null,
          pid: typeof lease.pid === "number" ? lease.pid : null,
          process_group: typeof lease.processGroup === "number" ? lease.processGroup : 0,
          command_label: typeof lease.commandLabel === "string" ? lease.commandLabel : "runtime process",
          state: typeof lease.state === "string" ? lease.state : "active",
          runtime_kind: lease.runtimeKind === "wsl" ? "wsl" : undefined,
          runtime_distribution: typeof lease.runtimeDistribution === "string" ? lease.runtimeDistribution : null,
          runtime_pid: typeof lease.runtimePid === "number" ? lease.runtimePid : null,
          runtime_pgid: typeof lease.runtimePgid === "number" ? lease.runtimePgid : null,
        };
        registerAuthoritativeLease(record);
        if (!(await stopRecordedProcess(record))) unresolved.push(record);
      }
    }
    return unresolved;
  }
}

/** Query the Rust process ledger; callers never infer ownership from PID alone. */
export async function listOwnedProcesses(sessionId?:string):Promise<OwnedProcessRecord[]> {
  const {runtimeFacade}=await import('./sidecar/runtime-facade.js');
  const sessions=sessionId?[{id:sessionId}]:await runtimeFacade.listSessionProjection() as Array<{id:string}>;
  const records:OwnedProcessRecord[]=[];
  for(const session of sessions){
    const state=await runtimeFacade.controlState(session.id) as {processLeases?:Array<Record<string,unknown>>};
    for(const l of state.processLeases ?? []) records.push({id:String(l.leaseId),host_id:String(l.hostId),session_id:session.id,run_id:typeof l.runId==='string'?l.runId:null,pid:typeof l.pid==='number'?l.pid:null,process_group:Number(l.processGroup??0),command_label:String(l.commandLabel??''),state:String(l.state??'unknown'),kind:String(l.kind??'command'),started_at:typeof l.startedAt==='string'?l.startedAt:undefined,runtime_kind:l.runtimeKind==='wsl'?'wsl':'host',runtime_distribution:typeof l.runtimeDistribution==='string'?l.runtimeDistribution:null,runtime_pid:typeof l.runtimePid==='number'?l.runtimePid:null,runtime_pgid:typeof l.runtimePgid==='number'?l.runtimePgid:null});
  }
  return records;
}
