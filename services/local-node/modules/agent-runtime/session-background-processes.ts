import { terminalManager } from "../../infrastructure/terminals/terminal-manager.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { agentRuntimeStore } from "./session-store.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { stopRecordedProcess, type OwnedProcessRecord } from "./process-ownership.js";
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
  ports?: number[];
}

export function detectServicePorts(command: string): number[] {
  const ports = new Set<number>();
  const add = (value: string | undefined) => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };
  for (const match of command.matchAll(/\bPORT\s*=\s*(\d{1,5})\b/gi)) add(match[1]);
  for (const match of command.matchAll(/--port[=\s]+(\d{1,5})\b/gi)) add(match[1]);
  for (const match of command.matchAll(/(?:^|[\s=])-p\s*(\d{1,5})(?::(\d{1,5}))?\b/g)) {
    add(match[1]); add(match[2]);
  }
  for (const match of command.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\*):(\d{2,5})\b/gi)) add(match[1]);
  for (const match of command.matchAll(/\bhttp\.server\s+(\d{1,5})\b/g)) add(match[1]);
  return [...ports].sort((a, b) => a - b);
}

function leaseRecord(sessionId: string, value: unknown): OwnedProcessRecord | null {
  if (!value || typeof value !== "object") return null;
  const lease = value as Record<string, unknown>;
  if (typeof lease.leaseId !== "string") return null;
  return {
    id: lease.leaseId,
    host_id: typeof lease.hostId === "string" ? lease.hostId : "unknown",
    session_id: sessionId,
    run_id: typeof lease.runId === "string" ? lease.runId : null,
    pid: typeof lease.pid === "number" ? lease.pid : null,
    process_group: typeof lease.processGroup === "number" ? lease.processGroup : 0,
    command_label: typeof lease.commandLabel === "string" ? lease.commandLabel : "runtime process",
    state: typeof lease.state === "string" ? lease.state : "active",
    kind: typeof lease.kind === "string" ? lease.kind : undefined,
    runtime_kind: lease.runtimeKind === "wsl" ? "wsl" : undefined,
    runtime_distribution: typeof lease.runtimeDistribution === "string" ? lease.runtimeDistribution : null,
    runtime_pid: typeof lease.runtimePid === "number" ? lease.runtimePid : null,
    runtime_pgid: typeof lease.runtimePgid === "number" ? lease.runtimePgid : null,
  };
}

export async function listSessionBackgroundProcesses(sessionId: string): Promise<SessionBackgroundProcess[]> {
  const session = agentRuntimeStore.getSession(sessionId);
  const [state, terminals] = await Promise.all([
    runtimeFacade.controlState(sessionId) as Promise<{ processLeases?: unknown[] }>,
    terminalManager.listAuthoritative(session.projectId),
  ]);
  const terminalById = new Map(terminals.filter(item => item.ownerSessionId === sessionId).map(item => [item.id, item]));
  const items = new Map<string, SessionBackgroundProcess>();
  for (const terminal of terminalById.values()) {
    const plainTerminal = terminal.kind === "terminal";
    const ports = plainTerminal ? [] : detectServicePorts(terminal.command ?? terminal.title);
    items.set(terminal.id, {
      id: terminal.id,
      command: terminal.command ?? terminal.title,
      pid: terminal.pid,
      state: terminal.state,
      exitCode: terminal.exitCode,
      startedAt: terminal.startedAt,
      endedAt: terminal.endedAt,
      terminalId: terminal.id,
      kind: terminal.kind,
      cwd: terminal.cwd,
      projectId: terminal.projectId,
      ...(ports.length ? { ports } : {}),
    });
  }
  for (const raw of Array.isArray(state.processLeases) ? state.processLeases : []) {
    const lease = leaseRecord(sessionId, raw);
    if (!lease || lease.kind !== "background" || items.has(lease.id)) continue;
    const ports = detectServicePorts(lease.command_label);
    items.set(lease.id, {
      id: lease.id,
      command: lease.command_label,
      pid: lease.pid,
      state: lease.state,
      exitCode: lease.exit_code ?? null,
      startedAt: lease.started_at ?? new Date().toISOString(),
      endedAt: lease.ended_at ?? null,
      ...(ports.length ? { ports } : {}),
    });
  }
  return [...items.values()].sort((a, b) => Number(b.state !== "closed") - Number(a.state !== "closed") || b.startedAt.localeCompare(a.startedAt));
}

async function ownedProcess(sessionId: string, processId: string): Promise<{ record?: OwnedProcessRecord; terminal?: boolean }> {
  const session = agentRuntimeStore.getSession(sessionId);
  const terminal = (await terminalManager.listAuthoritative(session.projectId)).find(item => item.id === processId && item.ownerSessionId === sessionId);
  if (terminal) {
    return {
      terminal: true,
      record: {
        id: terminal.id,
        host_id: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
        session_id: sessionId,
        run_id: null,
        pid: terminal.pid,
        process_group: process.platform === "win32" ? 0 : 1,
        command_label: terminal.command ?? terminal.title,
        state: terminal.state,
        kind: terminal.kind === "service" ? "background" : "terminal",
      },
    };
  }
  const state = await runtimeFacade.controlState(sessionId) as { processLeases?: unknown[] };
  const record = (Array.isArray(state.processLeases) ? state.processLeases : [])
    .map(raw => leaseRecord(sessionId, raw))
    .find(item => item?.id === processId && item.kind === "background");
  if (!record) throw new AgentNotFoundError(processId);
  return { record };
}

export async function stopSessionBackgroundProcesses(sessionIds: Iterable<string>): Promise<void> {
  for (const sessionId of [...new Set(sessionIds)]) {
    const items = await listSessionBackgroundProcesses(sessionId);
    for (const item of items.filter(item => item.state !== "closed"))
      await stopSessionBackgroundProcess(sessionId, item.id);
  }
}

export async function stopSessionBackgroundProcess(sessionId: string, processId: string): Promise<void> {
  const owned = await ownedProcess(sessionId, processId);
  if (owned.terminal) {
    await terminalManager.stop(processId);
    return;
  }
  if (owned.record?.state === "closed") return;
  if (!(await stopRecordedProcess(owned.record!)))
    throw new AgentRuntimeError("The service could not be safely identified or its termination confirmed.", "PROCESS_STOP_UNCONFIRMED", 409);
}

export async function deleteSessionBackgroundProcess(sessionId: string, processId: string): Promise<void> {
  const owned = await ownedProcess(sessionId, processId);
  if (owned.terminal) {
    if (owned.record?.state !== "closed") await terminalManager.stop(processId);
    terminalManager.remove(processId);
  } else if (owned.record?.state !== "closed") {
    throw new AgentRuntimeError("Stop the service before deleting its record.", "PROCESS_STILL_RUNNING", 409);
  }
  emitRuntimeBusEvent({ type: "session_process_changed", sessionId });
}
