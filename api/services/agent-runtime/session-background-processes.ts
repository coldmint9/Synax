import { terminalManager } from "../terminals/terminal-manager.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  stopRecordedProcess,
  type OwnedProcessRecord,
} from "./process-ownership.js";
import { AgentNotFoundError, AgentRuntimeError } from "./runtime-errors.js";

export interface SessionBackgroundProcess {
  id: string;
  command: string;
  pid: number | null;
  state: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  terminalId?: string;
  kind?: "terminal" | "service";
  cwd?: string;
  projectId?: string;
}

export function listSessionBackgroundProcesses(
  sessionId: string,
): SessionBackgroundProcess[] {
  const session = agentRuntimeStore.getSession(sessionId);
  const rows = getRawSqlite().prepare(`WITH visible AS (
    SELECT p.*, t.id AS terminal_id, t.kind AS terminal_kind, t.cwd, t.project_id
    FROM agent_runtime_processes p LEFT JOIN terminal_sessions t ON t.id=p.id
    WHERE (p.session_id=? AND p.kind='background') OR (t.project_id=? AND t.kind='terminal')
  ) SELECT * FROM visible WHERE state<>'closed' OR id IN (SELECT id FROM visible WHERE state='closed' ORDER BY started_at DESC LIMIT 5)
  ORDER BY (state<>'closed') DESC, started_at DESC`).all(sessionId, session.projectId) as Array<OwnedProcessRecord & { terminal_id?: string; terminal_kind?: "terminal" | "service"; cwd?: string; project_id?: string }>;
  return rows.map(row => ({ id: row.id, command: row.command_label, pid: row.pid, state: row.state,
    exitCode: row.exit_code ?? null, startedAt: row.started_at!, endedAt: row.ended_at ?? null,
    ...(row.terminal_id ? { terminalId: row.terminal_id, kind: row.terminal_kind, cwd: row.cwd, projectId: row.project_id } : {}),
  }));
}

function ownedRow(sessionId: string, processId: string): OwnedProcessRecord & { terminal_id?: string } {
  const session = agentRuntimeStore.getSession(sessionId);
  const row = getRawSqlite().prepare(`SELECT p.*, t.id AS terminal_id FROM agent_runtime_processes p
    LEFT JOIN terminal_sessions t ON t.id=p.id WHERE p.id=? AND
    ((p.session_id=? AND p.kind='background') OR (t.project_id=? AND t.kind='terminal'))`)
    .get(processId, sessionId, session.projectId) as (OwnedProcessRecord & { terminal_id?: string }) | undefined;
  if (!row) throw new AgentNotFoundError(processId);
  return row;
}
export async function stopSessionBackgroundProcess(sessionId: string, processId: string): Promise<void> {
  const row = ownedRow(sessionId, processId);
  if (row.terminal_id) { await terminalManager.stop(processId); return; }
  if (row.state === "closed") return;
  if (!(await stopRecordedProcess(row))) {
    getRawSqlite()
      .prepare(
        "UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?",
      )
      .run(processId);
    throw new AgentRuntimeError(
      "The service could not be safely identified or its termination confirmed.",
      "PROCESS_STOP_UNCONFIRMED",
      409,
    );
  }
}

/** Removing history is deliberately separate from stopping an owned process. */
export function deleteSessionBackgroundProcess(
  sessionId: string,
  processId: string,
): void {
  const row = ownedRow(sessionId, processId);
  const db = getRawSqlite();
  if (row.state !== "closed")
    throw new AgentRuntimeError(
      "Stop the service before deleting its record.",
      "PROCESS_STILL_RUNNING",
      409,
    );
  if (row.terminal_id) terminalManager.remove(processId);
  else db.prepare("DELETE FROM agent_runtime_processes WHERE id=? AND session_id=? AND kind='background' AND state='closed'").run(processId, sessionId);
  emitRuntimeBusEvent({ type: "session_process_changed", sessionId });
}
