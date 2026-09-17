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
}

export function listSessionBackgroundProcesses(
  sessionId: string,
): SessionBackgroundProcess[] {
  agentRuntimeStore.getSession(sessionId);
  const rows = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_processes WHERE session_id=? AND kind='background' AND (state<>'closed' OR id IN (SELECT id FROM agent_runtime_processes WHERE session_id=? AND kind='background' AND state='closed' ORDER BY started_at DESC LIMIT 5)) ORDER BY (state<>'closed') DESC, started_at DESC",
    )
    .all(sessionId, sessionId) as OwnedProcessRecord[];
  return rows.map((row) => ({
    id: row.id,
    command: row.command_label,
    pid: row.pid,
    state: row.state,
    exitCode: row.exit_code ?? null,
    startedAt: row.started_at!,
    endedAt: row.ended_at ?? null,
  }));
}

export async function stopSessionBackgroundProcess(
  sessionId: string,
  processId: string,
): Promise<void> {
  agentRuntimeStore.getSession(sessionId);
  const row = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_processes WHERE id=? AND session_id=? AND kind='background'",
    )
    .get(processId, sessionId) as OwnedProcessRecord | undefined;
  if (!row) throw new AgentNotFoundError(processId);
  if (row.state === "closed") return;
  if (!(await stopRecordedProcess(row))) {
    getRawSqlite().prepare("UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?").run(processId);
    throw new AgentRuntimeError(
      "The service could not be safely identified or its termination confirmed.",
      "PROCESS_STOP_UNCONFIRMED",
      409,
    );
  }
}
