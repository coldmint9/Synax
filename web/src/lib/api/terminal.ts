import { apiRequest } from "./origin";
export interface TerminalSession {
  id: string;
  projectId: string;
  rootId: string;
  ownerSessionId: string | null;
  kind: "terminal" | "service";
  title: string;
  cwd: string;
  shell: string;
  command: string | null;
  pid: number | null;
  state: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  cols: number;
  rows: number;
}
const base = "/api/terminals";
const projectPath = (projectId: string) =>
  `${base}/projects/${encodeURIComponent(projectId)}`;
const itemPath = (item: Pick<TerminalSession, "id" | "projectId">) =>
  `${projectPath(item.projectId)}/${encodeURIComponent(item.id)}`;
export const terminalApi = {
  create: (
    projectId: string,
    input: { rootId?: string; sessionId?: string; requestId: string },
  ) =>
    apiRequest<TerminalSession>(projectPath(projectId), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  list: (projectId: string) =>
    apiRequest<{ items: TerminalSession[] }>(projectPath(projectId)),
  get: (projectId: string, id: string) =>
    apiRequest<TerminalSession>(itemPath({ projectId, id })),
  connectionTicket: (item: TerminalSession) =>
    apiRequest<{ ticket: string }>(`${itemPath(item)}/connection`, {
      method: "POST",
      silent: true,
    }),
  streamUrl: itemPath,
  write: (
    item: TerminalSession,
    data: string,
    requestId: string,
    binary = false,
  ) =>
    apiRequest<{ ok: boolean }>(`${itemPath(item)}/input`, {
      method: "POST",
      body: JSON.stringify({ data, requestId, binary }),
    }),
  acknowledge: (item: TerminalSession, clientId: string, sequence: number) =>
    apiRequest<{ ok: boolean }>(`${itemPath(item)}/ack`, {
      method: "POST",
      body: JSON.stringify({ clientId, sequence }),
    }),
  resize: (item: TerminalSession, cols: number, rows: number) =>
    apiRequest<{ ok: boolean }>(`${itemPath(item)}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    }),
  stop: (item: TerminalSession) =>
    apiRequest<TerminalSession>(`${itemPath(item)}/stop`, { method: "POST" }),
  remove: (item: TerminalSession) =>
    apiRequest<{ ok: boolean }>(itemPath(item), { method: "DELETE" }),
  restartLegacy: (
    sessionId: string,
    processId: string,
    input: { command: string; cwd: string; requestId: string },
  ) =>
    apiRequest<TerminalSession>(
      `${base}/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/restart`,
      { method: "POST", body: JSON.stringify({ ...input, confirm: true }) },
    ),
};
