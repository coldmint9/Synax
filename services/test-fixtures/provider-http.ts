import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll } from "vitest";
import { ensureTestRuntime } from "./rust-runtime.js";

beforeAll(ensureTestRuntime);
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** Real loopback upstream: Rust owns the network request in every fixture. */
export async function serveProviderHttp(handler: (url: string, init: RequestInit) => Promise<Response>): Promise<string> {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const url = `http://127.0.0.1${req.url}`;
      const body = headers.get("content-type")?.includes("multipart/form-data")
        ? await new Request(url, { method: "POST", headers, body: bytes }).formData()
        : bytes.toString("utf8");
      if (body instanceof FormData) headers.delete("content-type");
      const response = await handler(url, { method: req.method, headers, body });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
      res.end();
    } catch (error) { res.destroy(error as Error); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}
