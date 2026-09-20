import { issueTerminalTicket } from "../services/terminals/terminal-socket.js";
import { canonicalWorkspaceDirectory } from "../services/project-workspace.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getRawSqlite } from "../db/index.js";
import { runWithExecutionContext } from "../lib/execution-context.js";
import { terminalManager } from "../services/terminals/terminal-manager.js";
import {
  createProjectTerminal,
  createServiceTerminal,
} from "../services/terminals/terminal-service.js";
import { agentRuntimeStore } from "../services/agent-runtime/session-store.js";
import { stopSessionBackgroundProcess } from "../services/agent-runtime/session-background-processes.js";
import {
  AgentRuntimeError,
  toHttpError,
} from "../services/agent-runtime/runtime-errors.js";

export const terminalRoutes = new Hono();
terminalRoutes.use("*", bodyLimit({ maxSize: 256 * 1024 }));
terminalRoutes.onError((error, c) => {
  if ((error as { code?: string }).code === "EXECUTION_SUPERSEDED")
    return c.json({ error: error.message, code: "EXECUTION_SUPERSEDED" }, 409);
  const mapped = toHttpError(error);
  return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
});
const requestId = z.string().regex(/^[\w:-]{8,128}$/);
const newTerminal = z.object({
  rootId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  requestId,
});
const service = z.object({
  command: z.string().min(1).max(32000),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().max(64000).optional(),
  waitForJobs: z.boolean().optional(),
  requestId,
  execution: z
    .object({
      sessionId: z.string(),
      runId: z.string(),
      epoch: z.string(),
      hostId: z.string(),
    })
    .optional(),
});
async function json<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AgentRuntimeError("Invalid JSON.", "INVALID_INPUT", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new AgentRuntimeError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
      "INVALID_INPUT",
      400,
    );
  return parsed.data;
}
function scoped(c: Context) {
  return terminalManager.get(c.req.param("id")!, c.req.param("projectId"));
}
terminalRoutes.get("/projects/:projectId", (c) =>
  c.json({ items: terminalManager.list(c.req.param("projectId")) }),
);
terminalRoutes.post("/projects/:projectId", async (c) =>
  c.json(
    await createProjectTerminal(
      c.req.param("projectId"),
      await json(c, newTerminal),
    ),
    201,
  ),
);
terminalRoutes.get("/projects/:projectId/:id", (c) => c.json(scoped(c)));
terminalRoutes.post("/projects/:projectId/:id/connection", (c) => {
  const item = scoped(c);
  return c.json({
    ticket: issueTerminalTicket(
      item.projectId,
      item.id,
      c.req.header("Origin"),
    ),
  });
});
terminalRoutes.post("/projects/:projectId/:id/input", async (c) => {
  const item = scoped(c);
  const body = await json(
    c,
    z.object({
      data: z.string().min(1).max(65536),
      requestId,
      binary: z.boolean().optional(),
    }),
  );
  terminalManager.write(item.id, body.data, body.requestId, body.binary);
  return c.json({ ok: true });
});
terminalRoutes.post("/projects/:projectId/:id/resize", async (c) => {
  const item = scoped(c);
  const body = await json(
    c,
    z.object({
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(1).max(300),
    }),
  );
  terminalManager.resize(item.id, body.cols, body.rows);
  return c.json({ ok: true });
});
terminalRoutes.post("/projects/:projectId/:id/stop", async (c) => {
  const item = scoped(c);
  await terminalManager.stop(item.id);
  return c.json(terminalManager.get(item.id));
});
terminalRoutes.delete("/projects/:projectId/:id", (c) => {
  const item = scoped(c);
  terminalManager.remove(item.id);
  return c.json({ ok: true });
});
terminalRoutes.post("/projects/:projectId/:id/ack", async (c) => {
  const item = scoped(c);
  const body = await json(
    c,
    z.object({ clientId: requestId, sequence: z.number().int().nonnegative() }),
  );
  terminalManager.acknowledge(item.id, body.clientId, body.sequence);
  return c.json({ ok: true });
});
terminalRoutes.get("/projects/:projectId/:id/stream", (c) => {
  const item = scoped(c);
  const clientId = c.req.query("clientId");
  if (clientId && !/^[\w:-]{8,128}$/.test(clientId))
    throw new AgentRuntimeError("Invalid reader ID.", "INVALID_INPUT", 400);
  const cursor = c.req.header("Last-Event-ID");
  const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : undefined;
  return streamSSE(c, async (stream) => {
    type Frame = { event: string; data: string; id?: string };
    let queue: Frame[] = [],
      bytes = 0,
      wake: (() => void) | undefined,
      disposed = false,
      ended = item.state === "closed";
    const push = (frame: Frame) => {
      if (disposed) return;
      if (bytes > 4 * 1024 * 1024) {
        const current = terminalManager.snapshot(item.id);
        queue = [
          {
            event: "terminal-reset",
            data: JSON.stringify(current),
            id: String(current.sequence),
          },
        ];
        bytes = current.data.length;
      } else {
        queue.push(frame);
        bytes += frame.data.length;
      }
      wake?.();
      wake = undefined;
    };
    const disconnectReader = clientId
      ? terminalManager.connectReader(item.id, clientId)
      : () => {};
    const unsubscribe = terminalManager.subscribe(item.id, (event) => {
      if (event.type === "output")
        push({
          event: "terminal-data",
          data: JSON.stringify(event.frame),
          id: String(event.frame.sequence),
        });
      else {
        ended = event.terminal.state === "closed";
        push({ event: "terminal-state", data: JSON.stringify(event.terminal) });
      }
    });
    const replay = terminalManager.replay(item.id, after);
    if (replay.reset)
      push({
        event: "terminal-reset",
        data: JSON.stringify({
          sequence: replay.sequence,
          data: replay.frames.map((frame) => frame.data).join(""),
        }),
        id: String(replay.sequence),
      });
    else
      for (const frame of replay.frames)
        push({
          event: "terminal-data",
          data: JSON.stringify(frame),
          id: String(frame.sequence),
        });
    push({ event: "terminal-state", data: JSON.stringify(item) });
    const timer = setInterval(
      () => push({ event: "terminal-ping", data: "{}" }),
      15_000,
    );
    stream.onAbort(() => {
      disposed = true;
      wake?.();
    });
    try {
      while (!disposed) {
        while (queue.length && !disposed) {
          const frame = queue.shift()!;
          bytes -= frame.data.length;
          await stream.writeSSE(frame);
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
      disconnectReader();
    }
  });
});
terminalRoutes.post("/sessions/:sessionId/services", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await json(c, service);
  if (
    body.execution &&
    (body.execution.sessionId !== sessionId ||
      body.execution.hostId !== process.env.SYNAX_RUNTIME_HOST_ID)
  )
    throw new AgentRuntimeError(
      "Execution lease does not belong to this runtime.",
      "EXECUTION_SUPERSEDED",
      409,
    );
  return c.json(
    await runWithExecutionContext(body.execution, () =>
      createServiceTerminal(sessionId, body),
    ),
    201,
  );
});
terminalRoutes.post(
  "/sessions/:sessionId/processes/:processId/restart",
  async (c) => {
    const sessionId = c.req.param("sessionId"),
      id = c.req.param("processId");
    agentRuntimeStore.getSession(sessionId);
    const previous = getRawSqlite()
      .prepare(
        "SELECT id FROM agent_runtime_processes WHERE id=? AND session_id=? AND kind='background'",
      )
      .get(id, sessionId);
    if (!previous)
      throw new AgentRuntimeError("Service not found.", "NOT_FOUND", 404);
    const body = await json(
      c,
      z.object({
        confirm: z.literal(true),
        command: z.string().min(1).max(32000),
        cwd: z.string().min(1).max(4096),
        requestId,
      }),
    );
    canonicalWorkspaceDirectory(body.cwd);
    if (!body.command.trim())
      throw new AgentRuntimeError(
        "A command is required.",
        "INVALID_INPUT",
        400,
      );
    await stopSessionBackgroundProcess(sessionId, id);
    return c.json(
      await createServiceTerminal(sessionId, {
        command: body.command,
        cwd: body.cwd,
        requestId: `restart:${id}:${body.requestId}`,
      }),
      201,
    );
  },
);
