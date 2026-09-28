import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
};
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-provider-delete-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "unit-test-secret";
  vi.resetModules();
});

afterEach(async () => {
  const dbModule = await import("../../db/index.js");
  dbModule.closeDb();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY;
});

const putGlobal = async (body: unknown) => {
  const { configRoutes } = await import("../config.js");
  const res = await configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const getConfig = async () => {
  const { configRoutes } = await import("../config.js");
  const res = await configRoutes.request("http://localhost/global");
  return (await res.json()).config as any;
};

const providerIds = (config: any): string[] =>
  config.providers.map((provider: any) => provider.id);

const customProvider = (id: string) => ({
  id,
  label: id,
  status: "live",
  kind: "api",
  caps: { canFollowUp: true, canCancel: true },
  models: [
    {
      id: "deepseek-chat",
      label: "deepseek-chat",
      isDefault: true,
      inputModalities: ["text", "image"],
    },
  ],
});

const customConnection = (id: string) => ({
  providerId: id,
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-test",
  extra: { kind: "api", apiFormat: "openai", model: "deepseek-chat" },
});

describe("LLM provider deletion", () => {
  it("deletes a custom provider that currently holds the default API provider", async () => {
    const official = (await getConfig()).providers;
    const added = await putGlobal({
      providers: [...official, customProvider("custom-api:deepseek")],
      providerConnections: { "custom-api:deepseek": customConnection("custom-api:deepseek") },
    });
    expect(added.status).toBe(200);

    // A single configured provider becomes the default automatically.
    const beforeDelete = await getConfig();
    expect(providerIds(beforeDelete)).toContain("custom-api:deepseek");
    expect(beforeDelete.defaultApiProviderId).toBe("custom-api:deepseek");

    // The settings UI deletes by omitting the provider; it does not restate a
    // default, so the server must repoint the default itself.
    const deleted = await putGlobal({ providers: official, providerConnections: {} });
    expect(deleted.status).toBe(200);

    const afterDelete = await getConfig();
    expect(providerIds(afterDelete)).not.toContain("custom-api:deepseek");
    expect(Object.keys(afterDelete.providerConnections)).not.toContain("custom-api:deepseek");
    // The stored default must never dangle on a removed provider.
    expect(providerIds(afterDelete)).toContain(afterDelete.defaultApiProviderId);
  });

  it("still rejects an explicitly requested unknown default provider", async () => {
    const official = (await getConfig()).providers;
    const rejected = await putGlobal({
      providers: official,
      defaultApiProviderId: "custom-api:missing",
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("默认 API provider 不存在");
  });

  it("keeps official providers undeletable", async () => {
    const official = (await getConfig()).providers;
    const rejected = await putGlobal({
      providers: official.filter((provider: any) => provider.id !== "openai"),
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("官方 provider 不可删除");
  });
});
