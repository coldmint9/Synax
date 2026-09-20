import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { terminalManager } from "./terminal-manager.js";
import { AgentRuntimeError } from "../agent-runtime/runtime-errors.js";

interface Ticket {
  terminalId: string;
  projectId: string;
  origin: string | undefined;
  expires: number;
}
const tickets = new Map<string, Ticket>();
/** Short-lived, single-use grants come from the already authenticated HTTP API. */
export function issueTerminalTicket(
  projectId: string,
  terminalId: string,
  origin?: string,
): string {
  terminalManager.get(terminalId, projectId);
  for (const [key, ticket] of tickets)
    if (ticket.expires < Date.now()) tickets.delete(key);
  if (tickets.size >= 128)
    throw new AgentRuntimeError(
      "Too many pending terminal connections.",
      "TERMINAL_LIMIT",
      429,
    );
  const key = randomBytes(32).toString("hex");
  tickets.set(key, {
    projectId,
    terminalId,
    origin,
    expires: Date.now() + 30_000,
  });
  return key;
}
export function consumeTerminalTicket(key: string, origin?: string): Ticket {
  const ticket = tickets.get(key);
  tickets.delete(key);
  if (!ticket || ticket.expires < Date.now() || ticket.origin !== origin)
    throw new AgentRuntimeError(
      "Terminal connection is not authorized.",
      "AUTH_REQUIRED",
      401,
    );
  return ticket;
}

/** PTY data must not occupy HTTP/1.1 SSE slots: several terminals otherwise starve input requests. */
export function attachTerminalSockets(server: Server): () => void {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  const hosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(process.env.SYNAX_TRUSTED_HOSTS?.split(",").map((value) =>
      value.trim(),
    ) ?? []),
  ]);
  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", `http://${request.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }
    if (
      url.pathname !== "/api/terminals/socket" ||
      !hosts.has(url.hostname) ||
      sockets.clients.size >= 128
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws, request),
    );
  });
  sockets.on("connection", (socket, request) => {
    let terminalId: string | undefined,
      unsubscribe = () => {},
      disconnectReader = () => {},
      alive = true;
    const readerId = randomUUID();
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, "Slow terminal reader. Reconnect to resume.");
        return;
      }
      socket.send(JSON.stringify(value));
    };
    const authTimer = setTimeout(
      () => socket.close(1008, "Authentication required."),
      5000,
    );
    const heartbeat = setInterval(() => {
      if (!alive) socket.terminate();
      else {
        alive = false;
        socket.ping();
      }
    }, 20000);
    authTimer.unref();
    heartbeat.unref();
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      unsubscribe();
      disconnectReader();
    });
    socket.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error("Expected a terminal protocol frame.");
        const message = JSON.parse(raw.toString());
        if (!terminalId) {
          if (message.type !== "attach" || typeof message.ticket !== "string")
            throw new Error("Authentication required.");
          const ticket = consumeTerminalTicket(
            message.ticket,
            request.headers.origin,
          );
          const terminal = terminalManager.get(
            ticket.terminalId,
            ticket.projectId,
          );
          terminalId = terminal.id;
          clearTimeout(authTimer);
          disconnectReader = terminalManager.connectReader(
            terminalId,
            readerId,
          );
          unsubscribe = terminalManager.subscribe(terminalId, (event) => {
            if (event.type === "output") send({ type: "data", ...event.frame });
            else {
              send({ type: "state", terminal: event.terminal });
              if (event.terminal.state === "closed")
                socket.close(1000, "Terminal exited.");
            }
          });
          const after =
            Number.isSafeInteger(message.after) && message.after >= 0
              ? (message.after as number)
              : undefined;
          send({
            type: "ready",
            terminal,
            replay: terminalManager.replay(terminalId, after),
          });
          if (terminal.state === "closed")
            socket.close(1000, "Terminal exited.");
          return;
        }
        switch (message.type) {
          case "input":
            if (
              typeof message.data !== "string" ||
              typeof message.requestId !== "string" ||
              (message.binary !== undefined &&
                typeof message.binary !== "boolean")
            )
              throw new Error("Invalid terminal input.");
            terminalManager.write(
              terminalId,
              message.data,
              message.requestId,
              message.binary === true,
            );
            break;
          case "resize":
            terminalManager.resize(terminalId, message.cols, message.rows);
            break;
          case "redraw": terminalManager.redraw(terminalId); break;
          case "ack":
            if (!Number.isSafeInteger(message.sequence) || message.sequence < 0)
              throw new Error("Invalid acknowledgement.");
            terminalManager.acknowledge(terminalId, readerId, message.sequence);
            break;
          default:
            throw new Error("Unknown terminal operation.");
        }
      } catch (error) {
        if (!terminalId)
          socket.close(1008, "Terminal connection is not authorized.");
        else
          send({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Terminal operation failed.",
          });
      }
    });
  });
  return () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    tickets.clear();
  };
}
