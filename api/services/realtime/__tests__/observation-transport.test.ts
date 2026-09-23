import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocket } from "ws";
import { installRuntimeAccess } from "../../../middleware/runtime-access.js";
import { ObservationTransport, observationPath } from "../observation-transport.js";
import { SseDecoder } from "../sse-decoder.js";

const origin = "http://localhost:5173";
let server: Server, base: string, root: string, close: () => void;
let cookie = "", clock = Date.now();
const clients: WebSocket[] = [];
const observations: Array<{ url: string; cursor: string | null; signal: AbortSignal; stream: ReadableStreamDefaultController<Uint8Array> }> = [];
const text = new TextEncoder();
beforeEach(async () => {
  observations.length = 0;
  root = mkdtempSync(path.join(os.tmpdir(), "synax-realtime-"));
  const app = new Hono();
  installRuntimeAccess(app, { dataRoot: root, webOrigins: [origin] });
  const transport = new ObservationTransport(request => app.fetch(request), () => clock);
  app.route("/api/realtime", transport.routes);
  app.get("/api/health", c => c.json({ ok: true }));
  app.get("/api/agent-runtime/sessions/missing/stream", c => c.json({ error: "missing" }, 404));
  app.get("/api/*", c => {
    const signal = c.req.raw.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        const item = { url: c.req.path, cursor: c.req.header("Last-Event-ID") ?? null, signal, stream };
        observations.push(item);
        stream.enqueue(text.encode(`id: 7\nevent: snapshot\ndata: {"path":${JSON.stringify(c.req.path)}}\n\n`));
        signal.addEventListener("abort", () => { try { stream.close(); } catch { /* cancelled */ } }, { once: true });
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  server = await new Promise<Server>(resolve => {
    const instance = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }, () => resolve(instance as Server));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = transport.attach(server);
  const auth = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } });
  cookie = auth.headers.get("set-cookie")!.split(";")[0];
  await auth.arrayBuffer();
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
async function ticket() {
  const response = await fetch(`${base}/api/realtime/connection`, { method: "POST", headers: { Origin: origin, Cookie: cookie } });
  expect(response.status).toBe(200);
  return (await response.json() as { ticket: string }).ticket;
}
async function connect(clientOrigin = origin) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/api/realtime/socket`, { origin: clientOrigin });
  const frames: any[] = [];
  socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, frames, send: (frame: object) => socket.send(JSON.stringify(frame)) };
}
async function authorized() {
  const grant = await ticket(), client = await connect();
  client.send({ type: "attach", ticket: grant });
  await vi.waitFor(() => expect(client.frames[0]?.type).toBe("ready"));
  return client;
}

it("requires the existing HTTP authorization before issuing a connection grant", async () => {
  const response = await fetch(`${base}/api/realtime/connection`, { method: "POST", headers: { Origin: origin } });
  expect(response.status).toBe(401);
  const crossSite = await fetch(`${base}/api/realtime/connection`, { method: "POST", headers: { Origin: "https://evil.invalid", Cookie: cookie } });
  expect(crossSite.status).toBe(403);
});
it("binds a single-use expiring grant to the origin, without exposing any data before attach", async () => {
  const grant = await ticket();
  const wrong = await connect("http://wrong.invalid");
  const denied = new Promise<number>(resolve => wrong.socket.once("close", resolve));
  wrong.send({ type: "attach", ticket: grant });
  expect(await denied).toBe(1008); expect(wrong.frames).toEqual([]);
  const replay = await connect();
  const replayed = new Promise<number>(resolve => replay.socket.once("close", resolve));
  replay.send({ type: "attach", ticket: grant });
  expect(await replayed).toBe(1008);
  const expiring = await ticket(), expired = await connect();
  const expiry = new Promise<number>(resolve => expired.socket.once("close", resolve));
  clock += 31_000;
  expired.send({ type: "attach", ticket: expiring });
  expect(await expiry).toBe(1008); expect(observations).toHaveLength(0);
});
it("multiplexes four contracts for four tabs without consuming ordinary HTTP connection slots", async () => {
  const client = await authorized();
  const paths = ["/api/agent-runtime/events/stream", "/api/notifications/stream?projectId=p", "/api/context/sync?projectId=p", "/api/agent-runtime/sessions/s/stream"];
  for (let tab = 0; tab < 4; tab++) paths.forEach((path, i) => client.send({ type: "subscribe", id: `${tab}:${i}`, path, cursor: "6" }));
  await vi.waitFor(() => expect(client.frames.filter(f => f.type === "event")).toHaveLength(16));
  expect(observations.every(o => o.cursor === "6")).toBe(true);
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  client.send({ type: "unsubscribe", id: "0:0" });
  await vi.waitFor(() => expect(observations[0].signal.aborted).toBe(true));
  expect(observations.slice(1).every(o => !o.signal.aborted)).toBe(true);
  client.socket.close();
  await vi.waitFor(() => expect(observations.every(o => o.signal.aborted)).toBe(true));
});
it("keeps subscription failures local and gives each late subscriber its own snapshot", async () => {
  const client = await authorized();
  client.send({ type: "subscribe", id: "one", path: "/api/agent-runtime/sessions/s/stream" });
  await vi.waitFor(() => expect(client.frames.some(f => f.type === "event" && f.id === "one")).toBe(true));
  client.send({ type: "subscribe", id: "two", path: "/api/agent-runtime/sessions/s/stream" });
  client.send({ type: "subscribe", id: "missing", path: "/api/agent-runtime/sessions/missing/stream" });
  await vi.waitFor(() => expect(client.frames.some(f => f.type === "error" && f.id === "missing" && f.status === 404)).toBe(true));
  expect(client.frames.some(f => f.type === "event" && f.id === "two")).toBe(true);
  expect(client.socket.readyState).toBe(WebSocket.OPEN);
});
it("rejects arbitrary proxy targets and malformed subscription frames", async () => {
  const client = await authorized();
  const denied = new Promise<number>(resolve => client.socket.once("close", resolve));
  client.send({ type: "subscribe", id: "x", path: "/api/config/global" });
  expect(await denied).toBe(1008); expect(observations).toHaveLength(0);
});
it("bounds subscription count and removes its own upgrade handler on shutdown", async () => {
  const client = await authorized();
  for (let i = 0; i < 129; i++) client.send({ type: "subscribe", id: String(i), path: "/api/agent-runtime/events/stream" });
  await vi.waitFor(() => expect(client.frames.some(f => f.type === "error" && f.status === 429)).toBe(true));
  expect(observations).toHaveLength(128);
  const before = server.listenerCount("upgrade"); close();
  expect(server.listenerCount("upgrade")).toBe(before - 1);
});

describe("SSE wire compatibility", () => {
  it("parses split UTF-8, multiline data and cursors, ignoring comments", () => {
    const frames: unknown[] = [], parser = new SseDecoder(frame => frames.push(frame));
    const bytes = text.encode(": heartbeat\r\nid: 17\r\nevent: chunk\r\ndata: 你好\r\ndata: world\r\n\r\n");
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    expect(frames).toEqual([{ event: "chunk", data: "你好\nworld", lastEventId: "17" }]);
  });
  it("rejects an unterminated oversized frame", () => {
    const parser = new SseDecoder(() => {}, 8);
    expect(() => parser.push(text.encode("data: abc"))).toThrow(/budget/);
  });
  it.each(["https://evil.invalid/api/context/sync", "/api/../api/config/global", "/api/context/sync", "/api/context/sync?projectId=p&target=x", "/api/agent-runtime/events/stream?token=secret"])("does not accept %s", path => {
    expect(() => observationPath(path)).toThrow();
  });
});
