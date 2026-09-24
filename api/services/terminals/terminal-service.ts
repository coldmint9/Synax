import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_ROOT } from "../../lib/env.js";
import {
  currentExecutionContext,
  type RuntimeExecutionContext,
} from "../../lib/execution-context.js";
import { assertRuntimeExecutionCurrent } from "../../db/index.js";
import {
  canonicalWorkspaceDirectory,
  isWithinWorkspace,
  projectWorkspaceRoots,
  readWorkspaceProject,
} from "../project-workspace.js";
import { agentRuntimeStore } from "../agent-runtime/session-store.js";
import { resolveSessionRepository } from "../agent-runtime/session-environment.js";
import {
  resolveSessionWorkDir,
  resolveSessionWorkspaceRoots,
} from "../agent-runtime/tools/workspace.js";
import {
  AgentRuntimeError,
  AgentValidationError,
} from "../agent-runtime/runtime-errors.js";
import { terminalManager, type TerminalInfo } from "./terminal-manager.js";
import { parseWslUncPath } from "../workspace-location.js";

export function createProjectTerminal(
  projectId: string,
  input: { rootId?: string; sessionId?: string; requestId: string },
) {
  let root;
  if (input.sessionId) {
    const session = agentRuntimeStore.getSession(input.sessionId);
    if (session.projectId !== projectId)
      throw new AgentValidationError(
        "Session does not belong to this project.",
      );
    root = resolveSessionRepository(session.id, projectId, input.rootId, true);
  } else {
    const project = readWorkspaceProject(projectId);
    if (!project)
      throw new AgentRuntimeError("Project not found.", "NOT_FOUND", 404);
    const roots = projectWorkspaceRoots(project);
    if (roots.length > 1 && !input.rootId)
      throw new AgentValidationError(
        "Choose a workspace project for this terminal.",
      );
    root = input.rootId
      ? roots.find((item) => item.id === input.rootId)
      : roots.find((item) => item.role === "primary");
    if (!root || root.status !== "available")
      throw new AgentValidationError(
        "The selected workspace directory is unavailable.",
      );
  }
  return terminalManager.create({
    projectId,
    rootId: root.id,
    cwd: root.path,
    kind: "terminal",
    title: root.name,
    requestKey: `manual:${projectId}:${input.requestId}`,
  });
}
export async function createServiceTerminal(
  sessionId: string,
  input: {
    command: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    waitForJobs?: boolean;
    requestId?: string;
  },
): Promise<TerminalInfo> {
  const session = agentRuntimeStore.getSession(sessionId);
  const cwd = canonicalWorkspaceDirectory(
    input.cwd ?? resolveSessionWorkDir(sessionId, session.projectId),
  );
  const roots = resolveSessionWorkspaceRoots(sessionId, session.projectId);
  const root =
    roots.find((item) => isWithinWorkspace(item.path, cwd)) ??
    roots.find((item) => item.role === "primary");
  return terminalManager.create({
    projectId: session.projectId,
    rootId: root?.id ?? session.projectId,
    ownerSessionId: sessionId,
    cwd,
    env: input.env,
    stdin: input.stdin,
    kind: "service",
    title: input.command,
    command:
      input.waitForJobs &&
      (process.platform !== "win32" || Boolean(parseWslUncPath(cwd)))
        ? `${input.command}\nwait`
        : input.command,
    requestKey: input.requestId
      ? `service:${sessionId}:${input.requestId}`
      : undefined,
  });
}

/** Session/wiki workers borrow the API host's PTY; no native handle lives in a short-lived model worker. */
export async function startBackgroundTerminal(
  sessionId: string,
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    waitForJobs?: boolean;
    signal?: AbortSignal;
  },
): Promise<{ processId: string; pid: number }> {
  if (options.signal?.aborted)
    throw Object.assign(new Error("Command cancelled."), {
      name: "AbortError",
    });
  assertRuntimeExecutionCurrent();
  const requestId = randomUUID();
  const inWorker =
    process.env.SYNAX_AGENT_SESSION_CHILD === "1" ||
    process.env.SYNAX_WIKI_JOB_CHILD === "1";
  let terminal: TerminalInfo;
  const origin = process.env.SYNAX_TERMINAL_HOST_ORIGIN;
  let authorization: string | undefined;
  if (inWorker) {
    if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
      throw new Error("The interactive terminal host is not available.");
    authorization = `Bearer ${(await fs.readFile(path.join(DATA_ROOT, "runtime-access-token"), "utf8")).trim()}`;
    const response = await fetch(
      `${origin}/api/terminals/sessions/${encodeURIComponent(sessionId)}/services`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...options,
          signal: undefined,
          command,
          requestId,
          execution: currentExecutionContext(),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await response.json()) as TerminalInfo & { error?: string };
    if (!response.ok)
      throw new Error(body.error ?? "Terminal service could not be started.");
    terminal = body;
  } else
    terminal = await createServiceTerminal(sessionId, {
      ...options,
      command,
      requestId,
    });
  // A background service is detached once the terminal host has accepted it.
  // The originating turn may be cancelled while this request is completing,
  // but that must not stop a service the user explicitly asked to keep alive.
  return { processId: terminal.id, pid: terminal.pid! };
}
export type TerminalExecution = RuntimeExecutionContext;
