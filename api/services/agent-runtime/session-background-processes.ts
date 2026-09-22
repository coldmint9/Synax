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
  /** Listening/mapped ports inferred from the service command; services only. */
  ports?: number[];
}

/**
 * Infer which ports a background service command exposes. Plain terminals are
 * never parsed; this only decorates rows that run a service command.
 */
export function detectServicePorts(command: string): number[] {
  const ports = new Set<number>();
  const add = (value: string | undefined) => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };
  for (const match of command.matchAll(/\bPORT\s*=\s*(\d{1,5})\b/gi))
    add(match[1]);
  for (const match of command.matchAll(/--port[=\s]+(\d{1,5})\b/gi))
    add(match[1]);
  // Short flag, including docker-style host:container mappings (-p 8080:80).
  for (const match of command.matchAll(
    /(?:^|[\s=])-p\s*(\d{1,5})(?::(\d{1,5}))?\b/g,
  )) {
    add(match[1]);
    add(match[2]);
  }
  for (const match of command.matchAll(
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\*):(\d{2,5})\b/gi,
  ))
    add(match[1]);
  for (const match of command.matchAll(/\bhttp\.server\s+(\d{1,5})\b/g))
    add(match[1]);
  return [...ports].sort((a, b) => a - b);
}

export function listSessionBackgroundProcesses(
  sessionId: string,
): SessionBackgroundProcess[] {
  const rows = getRawSqlite()
    .prepare(
      `WITH visible AS (
    SELECT p.*, t.id AS terminal_id, t.kind AS terminal_kind, t.cwd, t.project_id
    FROM agent_runtime_processes p LEFT JOIN terminal_sessions t ON t.id=p.id
    WHERE p.session_id=? AND p.kind='background'
  ) SELECT * FROM visible WHERE state<>'closed' OR id IN (SELECT id FROM visible WHERE state='closed' ORDER BY started_at DESC LIMIT 5)
  ORDER BY (state<>'closed') DESC, started_at DESC`,
    )
    .all(sessionId) as Array<
    OwnedProcessRecord & {
      terminal_id?: string;
      terminal_kind?: "terminal" | "service";
      cwd?: string;
      project_id?: string;
    }
  >;
  return rows.map((row) => {
    const plainTerminal = row.terminal_kind === "terminal";
    const ports = plainTerminal
      ? []
      : detectServicePorts(row.command_label ?? "");
    return {
      id: row.id,
      command: row.command_label,
      pid: row.pid,
      state: row.state,
      exitCode: row.exit_code ?? null,
      startedAt: row.started_at!,
      endedAt: row.ended_at ?? null,
      ...(row.terminal_id
        ? {
            terminalId: row.terminal_id,
            kind: row.terminal_kind,
            cwd: row.cwd,
            projectId: row.project_id,
          }
        : {}),
      ...(ports.length ? { ports } : {}),
    };
  });
}

function ownedRow(
  sessionId: string,
  processId: string,
): OwnedProcessRecord & { terminal_id?: string } {
  const session = agentRuntimeStore.getSession(sessionId);
  const row = getRawSqlite()
    .prepare(
      `SELECT p.*, t.id AS terminal_id FROM agent_runtime_processes p
    LEFT JOIN terminal_sessions t ON t.id=p.id WHERE p.id=? AND
    ((p.session_id=? AND p.kind='background') OR (t.project_id=? AND t.kind='terminal'))`,
    )
    .get(processId, sessionId, session.projectId) as
    | (OwnedProcessRecord & { terminal_id?: string })
    | undefined;
  if (!row) throw new AgentNotFoundError(processId);
  return row;
}
export async function stopSessionBackgroundProcess(
  sessionId: string,
  processId: string,
): Promise<void> {
  const row = ownedRow(sessionId, processId);
  if (row.terminal_id) {
    await terminalManager.stop(processId);
    return;
  }
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
export async function deleteSessionBackgroundProcess(
  sessionId: string,
  processId: string,
): Promise<void> {
  const row = ownedRow(sessionId, processId);
  const db = getRawSqlite();
  if (row.terminal_id) {
    // Plain terminals have no service lifecycle: deleting the row directly
    // stops the shell and clears the terminal session in one step.
    if (row.state !== "closed") await terminalManager.stop(processId);
    terminalManager.remove(processId);
  } else {
    if (row.state !== "closed")
      throw new AgentRuntimeError(
        "Stop the service before deleting its record.",
        "PROCESS_STILL_RUNNING",
        409,
      );
    db.prepare(
      "DELETE FROM agent_runtime_processes WHERE id=? AND session_id=? AND kind='background' AND state='closed'",
    ).run(processId, sessionId);
  }
  emitRuntimeBusEvent({ type: "session_process_changed", sessionId });
}
