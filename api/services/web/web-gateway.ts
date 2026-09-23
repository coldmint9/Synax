import http, { type IncomingMessage, type ServerResponse } from "node:http";
import http2, { type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "http2-settings"]);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm" };
function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const excluded = new Set([...HOP_HEADERS, ...String(headers.connection ?? "").toLowerCase().split(",").map(v => v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !name.startsWith(":") && !excluded.has(name)));
}

export interface WebGatewayOptions {
  root: string;
  apiOrigin: string;
  /** TLS enables h2 for HTTP; allowHTTP1 preserves ordinary WebSocket upgrades. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  allowedHosts?: string[];
}

/** Same-origin front door: h2 REST/assets + wss observations, without Vite's
 * HTTP/1.1 proxy downgrade. No TLS verification bypass or credentials in URLs. */
export async function createWebGateway(options: WebGatewayOptions) {
  const root = await realpath(options.root);
  const api = new URL(options.apiOrigin);
  if (api.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.pathname !== "/" || api.search || api.hash || api.username || api.password)
    throw new Error("Web gateway requires an explicit local HTTP runtime origin.");
  const hosts = new Set(options.allowedHosts ?? ["localhost", "127.0.0.1", "[::1]"]);
  const connections = new Set<Duplex>();
  const sessions = new Set<http2.ServerHttp2Session>();
  const trustedHost = (req: IncomingMessage | Http2ServerRequest) => {
    try { return hosts.has(new URL(`http://${req.headers[":authority"] ?? req.headers.host}`).hostname); } catch { return false; }
  };
  const request = async (req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) => {
    if (!trustedHost(req)) { res.writeHead(403); res.end("Untrusted web host."); return; }
    if (req.url?.startsWith("/api/") || req.url === "/api" || req.url?.startsWith("/oauth/")) {
      const upstream = http.request(api, { method: req.method, path: req.url, headers: { ...endToEnd(req.headers), host: api.host } }, response => {
        // HTTP/2 rejects HTTP/1.1 hop-by-hop response headers.
        res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
        response.pipe(res);
        response.on("error", () => res.destroy());
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Local runtime unavailable."); });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
      let file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
      try { if (!(await stat(file)).isFile()) file = path.join(root, "index.html"); }
      catch {
        if (path.extname(pathname)) { res.writeHead(404); res.end(); return; }
        file = path.join(root, "index.html");
      }
      file = await realpath(file);
      if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
      const info = await stat(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size, "X-Content-Type-Options": "nosniff",
        "Cache-Control": path.basename(file) === "index.html" ? "no-store" : file.startsWith(path.join(root, "assets") + path.sep) ? "public, max-age=31536000, immutable" : "no-cache" });
      if (req.method === "HEAD") { res.end(); return; }
      const stream = createReadStream(file);
      stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  };
  const server = options.tls
    ? http2.createSecureServer({ ...options.tls, allowHTTP1: true }, request)
    : http.createServer(request);
  if (options.tls) (server as http2.Http2SecureServer).on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!trustedHost(req) || !["/api/realtime/socket", "/api/terminals/socket"].includes(req.url ?? "")) { socket.destroy(); return; }
    const upstream = http.request(api, { path: req.url, headers: { ...req.headers, host: api.host }, method: "GET" });
    const fail = () => { upstream.destroy(); socket.destroy(); };
    socket.on("error", fail); socket.on("close", () => upstream.destroy());
    upstream.on("error", fail);
    upstream.on("response", response => { response.resume(); fail(); });
    upstream.on("upgrade", (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map(value => `${key}: ${value}\r\n`)).join("")}\r\n`);
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      peer.on("error", () => socket.destroy()); peer.on("close", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.end();
  });
  return {
    server,
    protocol: options.tls ? "h2+http/1.1" : "http/1.1",
    async listen(port: number, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => { server.off("error", failed); resolve(); });
      });
      return (server.address() as { port: number }).port;
    },
    async close() {
      for (const session of sessions) session.destroy();
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
