import { terminalManager } from "../../infrastructure/terminals/terminal-manager.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  stopRecordedProcess,
  listOwnedProcesses,
  registerAuthoritativeLease,
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

export async function listSessionBackgroundProcesses(sessionId:string):Promise<SessionBackgroundProcess[]> {
  const session=agentRuntimeStore.getSession(sessionId);
  const terminals=await terminalManager.listAuthoritative(session.projectId);
  const owned=await listOwnedProcesses(sessionId);
  const result:SessionBackgroundProcess[]=terminals.filter(t=>t.ownerSessionId===sessionId).map(t=>({id:t.id,command:t.command ?? t.title,pid:t.pid,state:t.state,exitCode:t.exitCode,startedAt:t.startedAt,endedAt:t.endedAt,terminalId:t.id,kind:t.kind,cwd:t.cwd,projectId:t.projectId,ports:t.kind==='service'?detectServicePorts(t.command ?? ''):[]}));
  for(const p of owned) if(p.kind==='background' && !result.some(t=>t.id===p.id)) result.push({id:p.id,command:p.command_label,pid:p.pid,state:p.state,exitCode:p.exit_code ?? null,startedAt:p.started_at ?? session.createdAt,endedAt:p.ended_at ?? null,ports:detectServicePorts(p.command_label)});
  return result;
}
export async function stopSessionBackgroundProcesses(sessionIds:Iterable<string>):Promise<void> {
  for(const id of new Set(sessionIds)) for(const process of await listSessionBackgroundProcesses(id)) if(process.state!=='closed') await stopSessionBackgroundProcess(id,process.id);
}
export async function stopSessionBackgroundProcess(sessionId:string,processId:string):Promise<void> {
  const session=agentRuntimeStore.getSession(sessionId);
  const terminal=(await terminalManager.listAuthoritative(session.projectId)).find(t=>t.id===processId && (t.ownerSessionId===sessionId || t.kind==='terminal'));
  if(terminal){await terminalManager.stop(processId);return;}
  const record=(await listOwnedProcesses(sessionId)).find(p=>p.id===processId && p.kind==='background');
  if(!record) throw new AgentNotFoundError(processId);
  registerAuthoritativeLease(record);
  if(!await stopRecordedProcess(record)) throw new AgentRuntimeError('The service could not be identified or its termination confirmed.','PROCESS_STOP_UNCONFIRMED',409);
}
export async function deleteSessionBackgroundProcess(sessionId:string,processId:string):Promise<void> {
  const session=agentRuntimeStore.getSession(sessionId);
  const terminal=(await terminalManager.listAuthoritative(session.projectId)).find(t=>t.id===processId && (t.ownerSessionId===sessionId || t.kind==='terminal'));
  if(terminal){if(terminal.state!=='closed')await terminalManager.stop(processId);await terminalManager.remove(processId);}
  else if((await listOwnedProcesses(sessionId)).some(p=>p.id===processId && p.state!=='closed')) throw new AgentRuntimeError('Stop the service before deleting its record.','PROCESS_STILL_RUNNING',409);
  emitRuntimeBusEvent({type:'session_process_changed',sessionId});
}
