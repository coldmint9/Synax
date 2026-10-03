import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { SseDecoder } from "./sse-decoder.js";

export const OBSERVATION_SOCKET_PATH = "/api/realtime/socket";
const TICKET_TTL = 30_000;
const MAX_SUBSCRIPTIONS = 128;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
interface Grant { origin: string | undefined; expires: number; base: string; headers: Headers }
interface Observation { controller: AbortController; request?: Request; cancel?: () => Promise<void> }

/** Deliberately not a generic HTTP proxy: only read-only observation routes. */
export function observationPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/api/") || value.length > 2048)
    throw new Error("Invalid observation path.");
  const url = new URL(value, "http://runtime.invalid");
  if (url.hash || url.origin !== "http://runtime.invalid") throw new Error("Invalid observation path.");
  const projectStream = ["/api/notifications/stream", "/api/context/sync"].includes(url.pathname);
  if (projectStream) {
    const project = url.searchParams.get("projectId");
    if (!project || project.length > 256 || [...url.searchParams.keys()].some(k => k !== "projectId") || url.searchParams.getAll("projectId").length !== 1)
      throw new Error("Invalid project observation.");
    return `${url.pathname}?projectId=${encodeURIComponent(project)}`;
  }
  if (url.search) throw new Error("Invalid observation query.");
  if (url.pathname === "/api/agent-runtime/events/stream") return url.pathname;
  if (/^\/api\/agent-runtime\/sessions\/[a-zA-Z0-9_.:-]{1,256}\/stream$/.test(url.pathname)) return url.pathname;
  if (/^\/api\/agent-runtime\/sessions\/[a-zA-Z0-9_.:-]{1,256}\/runs\/[a-zA-Z0-9_.:-]{1,256}\/stream$/.test(url.pathname)) return url.pathname;
  throw new Error("Unsupported observation path.");
}

/** One authenticated physical socket, many independent read-only observations.
 * Existing handlers own snapshots, replay and authorization; no second event ledger. */
export class ObservationTransport {
  readonly routes = new Hono();
  private readonly tickets = new Map<string, Grant>();
  constructor(private readonly fetch: (request: Request) => Response | Promise<Response>,
    private readonly now: () => number = Date.now) {
    this.routes.post("/connection", c => {
      for (const [key, grant] of this.tickets) if (grant.expires <= this.now()) this.tickets.delete(key);
      if (this.tickets.size >= 256) return c.json({ error: "Too many pending realtime grants." }, 429);
      const key = randomBytes(32).toString("hex");
      const headers = new Headers();
      for (const name of ["authorization", "cookie", "origin", "sec-fetch-site", "host"])
        if (c.req.header(name)) headers.set(name, c.req.header(name)!);
      this.tickets.set(key, { headers, base: new URL(c.req.url).origin,
        origin: c.req.header("origin"), expires: this.now() + TICKET_TTL });
      return c.json({ ticket: key, protocol: 1 });
    });
  }
  private consume(key: unknown, origin: string | undefined): Grant {
    if (typeof key !== "string") throw new Error("Authentication required.");
    const grant = this.tickets.get(key);
    this.tickets.delete(key);
    if (!grant || grant.expires <= this.now() || grant.origin !== origin)
      throw new Error("Authentication required.");
    return grant;
  }

  attach(server: Server): () => void {
    const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
    const hosts = new Set(["localhost", "127.0.0.1", "[::1]",
      ...(process.env.SYNAX_TRUSTED_HOSTS?.split(",").map(h => h.trim()).filter(Boolean) ?? [])]);
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try { url = new URL(request.url ?? "", `http://${request.headers.host}`); } catch { return; }
      // Each upgrade handler owns its route; never terminate the terminal socket.
      if (url.pathname !== OBSERVATION_SOCKET_PATH) return;
      if (url.search || !hosts.has(url.hostname) || sockets.clients.size >= 128) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
    };
    server.on("upgrade", upgrade);
    sockets.on("connection", (socket, request) => {
      let grant: Grant | undefined, alive = true;
      const observations = new Map<string, Observation>();
      const send = (frame: unknown) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const encoded = JSON.stringify(frame);
        if (Buffer.byteLength(encoded) > MAX_BUFFERED_BYTES || socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          socket.close(1013, "Slow observation reader. Reconnect for a snapshot.");
          return;
        }
        socket.send(encoded);
      };
      const stop = (id: string) => {
        const observation = observations.get(id);
        observations.delete(id);
        observation?.controller.abort();
        void observation?.cancel?.().catch(() => {});
      };
      const authTimer = setTimeout(() => socket.close(1008, "Authentication required."), 5000);
      authTimer.unref();
      const heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.ping();
        if (grant) send({ type: "heartbeat", at: this.now() });
      }, 20_000);
      heartbeat.unref();
      socket.on("pong", () => { alive = true; });
      socket.on("error", () => socket.terminate());
      socket.on("close", () => {
        clearTimeout(authTimer); clearInterval(heartbeat);
        for (const id of [...observations.keys()]) stop(id);
      });
      const observe = async (id: string, path: string, cursor: string | undefined) => {
        const observation: Observation = { controller: new AbortController() };
        observations.set(id, observation);
        const current = () => observations.get(id) === observation && !observation.controller.signal.aborted && socket.readyState === WebSocket.OPEN;
        try {
          const headers = new Headers(grant!.headers);
          headers.set("accept", "text/event-stream");
          if (cursor) headers.set("last-event-id", cursor);
          // Keep the dependent Request signal strongly reachable until unsubscribe.
          // Otherwise a long-lived reader can outlive Request's weak abort forwarding.
          observation.request = new Request(new URL(path, grant!.base), { headers, signal: observation.controller.signal });
          const response = await this.fetch(observation.request);
          if (!current()) { await response.body?.cancel(); return; }
          if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
            send({ type: "error", id, status: response.status, message: "Observation unavailable.", retryable: response.status >= 500 });
            await response.body?.cancel();
            return;
          }
          send({ type: "open", id });
          const decoder = new SseDecoder(event => { if (current()) send({ type: "event", id, ...event }); });
          const reader = response.body.getReader();
          observation.cancel = () => reader.cancel();
          try {
            while (current()) {
              const { done, value } = await reader.read();
              if (done) break;
              if (current()) decoder.push(value);
            }
            if (current()) send({ type: "error", id, status: 503, message: "Observation ended.", retryable: true });
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } catch {
          if (current()) send({ type: "error", id, status: 503, message: "Observation interrupted.", retryable: true });
        } finally {
          observation.controller.abort();
          if (observations.get(id) === observation) observations.delete(id);
        }
      };
      socket.on("message", (raw, binary) => {
        try {
          if (binary) throw new Error("Expected JSON.");
          const message = JSON.parse(raw.toString());
          if (!grant) {
            if (message?.type !== "attach") throw new Error("Authentication required.");
            grant = this.consume(message.ticket, request.headers.origin);
            clearTimeout(authTimer);
            send({ type: "ready", protocol: 1 });
            return;
          }
          if (message?.type === "ping") { send({ type: "heartbeat", at: this.now() }); return; }
          if (typeof message?.id !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/.test(message.id)) throw new Error("Invalid subscription id.");
          if (message.type === "unsubscribe") { stop(message.id); return; }
          if (message.type !== "subscribe") throw new Error("Invalid realtime operation.");
          const path = observationPath(message.path);
          if (message.cursor !== undefined && (typeof message.cursor !== "string" || message.cursor.length > 512 || /[\r\n\0]/.test(message.cursor)))
            throw new Error("Invalid observation cursor.");
          if (!observations.has(message.id) && observations.size >= MAX_SUBSCRIPTIONS) {
            send({ type: "error", id: message.id, status: 429, message: "Too many observations.", retryable: false });
            return;
          }
          stop(message.id);
          void observe(message.id, path, message.cursor);
        } catch {
          socket.close(1008, grant ? "Invalid realtime frame." : "Realtime connection is not authorized.");
        }
      });
    });
    return () => {
      server.off("upgrade", upgrade);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close(); this.tickets.clear();
    };
  }
}
