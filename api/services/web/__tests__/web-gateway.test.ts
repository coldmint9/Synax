import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import { execFileSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { createWebGateway } from "../web-gateway.js";
let directory: string, backend: http.Server, upstream: string, sockets: WebSocketServer;
let gateway: Awaited<ReturnType<typeof createWebGateway>> | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "synax-web-gateway-"));
  await mkdir(path.join(directory, "dist", "assets"), { recursive: true });
  await writeFile(path.join(directory, "dist", "index.html"), "<!doctype html><title>Synax</title>");
  await writeFile(path.join(directory, "dist", "assets", "main-abcd.js"), "console.log('loaded')");
  backend = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "keep-alive");
    res.setHeader("Set-Cookie", "runtime=value; HttpOnly; SameSite=Strict; Path=/api");
    res.end(JSON.stringify({ path: req.url, origin: req.headers.origin, cookie: req.headers.cookie, host: req.headers.host }));
  });
  sockets = new WebSocketServer({ noServer: true });
  backend.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    ws.on("message", value => ws.send(value.toString()));
  }));
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  upstream = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
});
afterEach(async () => {
  await gateway?.close(); gateway = undefined;
  for (const socket of sockets.clients) socket.terminate(); sockets.close();
  backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
async function tls() {
  const config = path.join(directory, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"), "-days", "1", "-config", config], { stdio: "ignore" });
  return { cert: await readFile(path.join(directory, "cert.pem")), key: await readFile(path.join(directory, "key.pem")) };
}
it("serves production files/SPA and proxies credentials without an origin change", async () => {
  gateway = await createWebGateway({ root: path.join(directory, "dist"), apiOrigin: upstream });
  const origin = `http://127.0.0.1:${await gateway.listen(0)}`;
  expect(await (await fetch(`${origin}/projects/p/sessions`)).text()).toContain("Synax");
  const asset = await fetch(`${origin}/assets/main-abcd.js`);
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
  const api = await fetch(`${origin}/api/health`, { headers: { Origin: origin, Cookie: "runtime=proof" } });
  expect(await api.json()).toMatchObject({ path: "/api/health", origin, cookie: "runtime=proof", host: new URL(upstream).host });
  expect(api.headers.get("set-cookie")).toContain("HttpOnly");
});
it("negotiates HTTP/2 for REST/assets while retaining HTTP/1.1 WebSocket upgrades", async () => {
  const keys = await tls();
  gateway = await createWebGateway({ root: path.join(directory, "dist"), apiOrigin: upstream, tls: keys });
  const origin = `https://localhost:${await gateway.listen(0)}`;
  const session = http2.connect(origin, { ca: keys.cert });
  try {
    const response = await new Promise<{ headers: http2.IncomingHttpHeaders; data: string }>((resolve, reject) => {
      const request = session.request({ ":path": "/api/health", origin }); let headers: http2.IncomingHttpHeaders = {}, data = "";
      request.on("response", value => { headers = value }); request.on("data", chunk => { data += chunk });
      request.on("error", reject); request.on("end", () => resolve({ headers, data })); request.end();
    });
    expect(session.alpnProtocol).toBe("h2"); expect(response.headers[":status"]).toBe(200);
    expect(response.headers.connection).toBeUndefined(); expect(JSON.parse(response.data).origin).toBe(origin);
    const socket = new WebSocket(`${origin.replace("https", "wss")}/api/realtime/socket`, { ca: keys.cert, origin });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) });
    const echoed = new Promise(resolve => socket.once("message", value => resolve(value.toString())));
    socket.send("multiplexed realtime"); expect(await echoed).toBe("multiplexed realtime"); socket.close();
    // Legacy HTTP/1.1 clients use the same secure listener, not a second insecure port.
    const status = await new Promise(resolve => https.get(`${origin}/`, { ca: keys.cert }, res => { res.resume(); resolve(res.statusCode) }));
    expect(status).toBe(200);
  } finally { session.destroy(); }
});
it("rejects host-header rebinding and files that escape through symlinks", async () => {
  await writeFile(path.join(directory, "secret.txt"), "not a web asset");
  await symlink(path.join(directory, "secret.txt"), path.join(directory, "dist", "escape.txt"));
  gateway = await createWebGateway({ root: path.join(directory, "dist"), apiOrigin: upstream });
  const origin = `http://127.0.0.1:${await gateway.listen(0)}`;
  const denied = await new Promise(resolve => http.get(`${origin}/`, { headers: { Host: "evil.invalid" } }, res => { res.resume(); resolve(res.statusCode); }));
  expect(denied).toBe(403);
  expect((await fetch(`${origin}/escape.txt`)).status).toBe(403);
});
it("does not forward local credentials to a remote runtime accidentally", async () => {
  await expect(createWebGateway({ root: path.join(directory, "dist"), apiOrigin: "http://evil.invalid" })).rejects.toThrow(/local/);
});
