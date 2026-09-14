import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getRawSqlite, tryGetRawSqlite } from '../../db/index.js';
import { currentExecutionContext, withoutExecutionContext } from '../../lib/execution-context.js';
import { nowIso } from './runtime-ids.js';

export interface OwnedProcessRecord {
  id: string; host_id: string; session_id: string | null; run_id: string | null; pid: number | null;
  process_group: number; state: string; command_label: string;
}
const INTERNAL_ENV = ['AGENT_SESSION_INIT', 'WIKI_JOB_INIT', 'SYNAX_AGENT_SESSION_CHILD', 'SYNAX_WIKI_JOB_CHILD', 'SYNAX_RUNTIME_HOST_ID', 'SYNAX_RUNTIME_DATA_ROOT', 'SYNAX_RECORDED_START'];

export function externalCommandEnvironment(overrides?: NodeJS.ProcessEnv, inherit = true): NodeJS.ProcessEnv {
  const env = { ...(inherit ? process.env : {}), ...overrides };
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  const internalWorker = process.env.SYNAX_AGENT_SESSION_CHILD === '1' || process.env.SYNAX_WIKI_JOB_CHILD === '1';
  if (env.DATA_ROOT && ((runtimeRoot && path.resolve(env.DATA_ROOT) === path.resolve(runtimeRoot)) || (internalWorker && env.DATA_ROOT === process.env.DATA_ROOT))) delete env.DATA_ROOT;
  for (const key of INTERNAL_ENV) delete env[key];
  return env;
}

export function prepareOwnedProcess(commandLabel: string, grouped: boolean) {
  const context = currentExecutionContext();
  const ticket = { id: randomUUID(), hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}` };
  getRawSqlite().prepare(`INSERT INTO agent_runtime_processes
    (id, host_id, session_id, run_id, pid, process_group, command_label, state, started_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'preparing', ?)`).run(ticket.id, ticket.hostId, context?.sessionId ?? null,
      context?.runId ?? null, grouped ? 1 : 0, commandLabel, nowIso());
  return ticket;
}
export function recordOwnedPid(id: string, pid: number | undefined): void {
  if (!pid) return;
  getRawSqlite().prepare("UPDATE agent_runtime_processes SET pid=?, state='active' WHERE id=?").run(pid, id);
}
export function releaseOwnedProcess(id: string): void {
  withoutExecutionContext(() => {
    try { tryGetRawSqlite()?.prepare("UPDATE agent_runtime_processes SET state='closed', ended_at=? WHERE id=?").run(nowIso(), id); }
    catch { /* Host recovery can recheck a receipt if shutdown already closed this connection. */ }
  });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function markerStatus(record: OwnedProcessRecord): Promise<'owned' | 'gone' | 'different' | 'unknown'> {
  if (!record.pid || !alive(record.pid)) return 'gone';
  try {
    if (process.platform === 'linux') {
      const entries = (await fs.readFile(`/proc/${record.pid}/environ`, 'utf8')).split('\0');
      return entries.includes(`SYNAX_PROCESS_OWNER=${record.id}`) ? 'owned' : 'different';
    }
    if (process.platform === 'darwin') {
      const text = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['eww', '-p', String(record.pid), '-o', 'command='],
        { timeout: 2000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      // Process environments may contain credentials: inspect the nonce only, never return or log this text.
      return new RegExp(`(?:^|\\s)SYNAX_PROCESS_OWNER=${record.id}(?:\\s|$)`).test(text) ? 'owned' : 'different';
    }
    return 'unknown';
  } catch { return alive(record.pid) ? 'unknown' : 'gone'; }
}

export async function stopRecordedProcess(record: OwnedProcessRecord): Promise<boolean> {
  const status = await markerStatus(record);
  if (status === 'gone' || status === 'different') { releaseOwnedProcess(record.id); return true; }
  if (status !== 'owned' || !record.pid) return false;
  const target = record.process_group && process.platform !== 'win32' ? -record.pid : record.pid;
  try { process.kill(target, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  const start = Date.now(); let forced = false;
  while (true) {
    let live = false;
    try { process.kill(target, 0); live = true; } catch (error) { live = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (!live) { releaseOwnedProcess(record.id); return true; }
    if (!forced && Date.now() - start > 1500) { try { process.kill(target, 'SIGKILL'); } catch {} forced = true; }
    if (Date.now() - start > 4000) return false;
    await delay(25);
  }
}

export async function recoverOwnedProcesses(hostId: string): Promise<OwnedProcessRecord[]> {
  const records = getRawSqlite().prepare("SELECT * FROM agent_runtime_processes WHERE host_id <> ? AND state <> 'closed'").all(hostId) as OwnedProcessRecord[];
  const unresolved: OwnedProcessRecord[] = [];
  for (const record of records.reverse()) {
    if (!await stopRecordedProcess(record)) {
      getRawSqlite().prepare("UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?").run(record.id);
      unresolved.push(record);
    }
  }
  return unresolved;
}


export async function stopHostProcesses(hostId: string): Promise<OwnedProcessRecord[]> {
  const records = getRawSqlite().prepare("SELECT * FROM agent_runtime_processes WHERE host_id=? AND state<>'closed'").all(hostId) as OwnedProcessRecord[];
  const unresolved: OwnedProcessRecord[] = [];
  for (const record of records.reverse()) if (!await stopRecordedProcess(record)) unresolved.push(record);
  return unresolved;
}
