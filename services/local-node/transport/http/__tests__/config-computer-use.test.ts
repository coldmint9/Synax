import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-computer-use-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "computer-use-test");
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../../infrastructure/database/index.js")).closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function put(body: unknown) {
  const { configRoutes } = await import("../config.js");
  return configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStored(): Promise<any> {
  return JSON.parse(
    fs.readFileSync(path.join(root, "config/global-config.json"), "utf8"),
  );
}

async function getGlobal(): Promise<any> {
  const { configRoutes } = await import("../config.js");
  const res = await configRoutes.request("http://localhost/global", {
    method: "GET",
  });
  return (await res.json()).config;
}

it("persists computer use settings and never returns the Jev key", async () => {
  const res = await put({
    computerUse: {
      enabled: true,
      strategy: "jev",
      perception: "auto",
      jev: {
        enabled: true,
        fallback: "fail_closed",
        providerId: "openai",
        model: "jev-1",
        apiKey: "sk-test-secret",
      },
    },
  });
  expect(res.status).toBe(200);
  const stored = await readStored();
  expect(String(stored.computerUse.jev.apiKey).startsWith("enc:v1:")).toBe(true);
  expect(stored.computerUse.jev.apiKeyMasked).toBeTruthy();
  expect(stored.computerUse.jev.apiKeyMasked).not.toBe("sk-test-secret");
  const config = await getGlobal();
  expect(config.computerUse.strategy).toBe("jev");
  expect(config.computerUse.perception).toBe("auto");
  expect(config.computerUse.jev.providerId).toBe("openai");
  expect(config.computerUse.jev.model).toBe("jev-1");
  expect(config.computerUse.jev.apiKey).toBeUndefined();
  expect(config.computerUse.jev.apiKeyMasked).toBeTruthy();
  expect(JSON.stringify(config)).not.toContain("sk-test-secret");
});

it("keeps the stored key when apiKey is omitted and clears it on empty string", async () => {
  await put({ computerUse: { jev: { enabled: true, apiKey: "sk-first" } } });
  await put({ computerUse: { jev: { enabled: true } } });
  let stored = await readStored();
  expect(String(stored.computerUse.jev.apiKey).startsWith("enc:v1:")).toBe(true);
  expect(stored.computerUse.strategy).toBe("auto");
  await put({ computerUse: { jev: { enabled: true, apiKey: "" } } });
  stored = await readStored();
  expect(stored.computerUse.jev.apiKey).toBeUndefined();
  expect(stored.computerUse.jev.apiKeyMasked).toBeUndefined();
});

it("rejects unknown computer use fields", async () => {
  const res = await put({ computerUse: { nope: true } });
  expect(res.status).toBe(400);
});

it("rejects a Jev provider that is not configured", async () => {
  const res = await put({
    computerUse: { jev: { enabled: true, providerId: "custom-api:missing" } },
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("Jev 供应商不存在");
  const config = await getGlobal();
  expect(config.computerUse?.jev?.providerId ?? null).toBeNull();
});

it("round-trips a configured Jev provider and clears it on null", async () => {
  const accepted = await put({
    computerUse: { jev: { enabled: true, providerId: "openai", model: "jev-1.13" } },
  });
  expect(accepted.status).toBe(200);
  let config = await getGlobal();
  expect(config.computerUse.jev.providerId).toBe("openai");
  expect(config.computerUse.jev.model).toBe("jev-1.13");

  const cleared = await put({
    computerUse: { jev: { enabled: true, providerId: null } },
  });
  expect(cleared.status).toBe(200);
  config = await getGlobal();
  expect(config.computerUse.jev.providerId ?? null).toBeNull();
});

it("round-trips global MCP servers", async () => {
  const servers = [
    {
      id: "docs",
      name: "Docs",
      command: "docs-server",
      args: ["--root", "docs"],
      env: { DOCS_TOKEN: "token" },
      enabled: false,
    },
  ];
  const res = await put({ mcpServers: servers });
  expect(res.status).toBe(200);
  const config = await getGlobal();
  expect(config.mcpServers).toEqual(servers);
  expect((await readStored()).mcpServers).toEqual(servers);
});
