import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccessTokenCache, RuntimeConnectionBroker, validateRuntimeConnectionRequest } from "./runtime-connection.js";

async function tokenFile(text = "secret\n"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synax-runtime-connection-"));
  const file = path.join(root, "runtime-access-token");
  await writeFile(file, text);
  return file;
}

function ticketResponse(): Response {
  return new Response(JSON.stringify({ transport: "rust", ticket: {} }), { status: 200 });
}

describe("runtime connection broker", () => {
  it("rejects malformed renderer requests before touching the backend", () => {
    expect(() => validateRuntimeConnectionRequest({ sessionId: "", clientId: "c", snapshot: true })).toThrow();
    expect(() => validateRuntimeConnectionRequest({ sessionId: "s", clientId: "c", snapshot: "yes" })).toThrow();
  });

  it("reads the access token once for consecutive handshakes", async () => {
    const file = await tokenFile();
    const tokens = new AccessTokenCache(file);
    const fetch = vi.fn(async () => ticketResponse());
    const broker = new RuntimeConnectionBroker({ tokenFile: file, port: async () => 4321, fetch });
    await broker.connection({ sessionId: "s", clientId: "c", snapshot: true });
    await broker.connection({ sessionId: "s", clientId: "c", snapshot: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await tokens.read()).toBe("secret");
  });

  it("shares one handshake between reconnect calls and backs off after a failure", async () => {
    const file = await tokenFile();
    let release: (() => void) | undefined;
    const fetch = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return ticketResponse();
    });
    const broker = new RuntimeConnectionBroker({ tokenFile: file, port: async () => 4321, fetch });
    const first = broker.connection({ sessionId: "s", clientId: "c", snapshot: true });
    const second = broker.connection({ sessionId: "s", clientId: "c", snapshot: true });
    expect(first).toBe(second);
    release?.();

    const failing = new RuntimeConnectionBroker({ tokenFile: file, port: async () => 4321,
      fetch: async () => new Response("no", { status: 503 }) });
    await expect(failing.connection({ sessionId: "s", clientId: "c", snapshot: true })).rejects.toThrow();
    await expect(failing.connection({ sessionId: "s", clientId: "c", snapshot: true })).rejects.toThrow(/backing off/);
  });
});
