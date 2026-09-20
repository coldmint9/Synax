import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
};
let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-metric-routes-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "metric-tests-only";
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../db/index.js")).closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const declaration = {
  version: 1,
  fields: [
    {
      path: "usage.credit_usage",
      type: "number",
      label: "Credits",
      unit: "credit",
      aggregation: "sum",
    },
    {
      path: "usage.credit_unit",
      type: "string",
      label: "Credit unit",
      aggregation: "latest",
    },
  ],
};
const request = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function route() {
  return (await import("../config.js")).configRoutes;
}

describe("provider metric API", () => {
  it("discovers fields with the saved key and never follows credential-bearing redirects", async () => {
    (await import("../../lib/config/config-store.js")).updateGlobalConfig(
      {
        providerConnections: {
          anthropic: {
            providerId: "anthropic",
            baseUrl: "http://localhost:3000/kiro/v1",
            apiKey: "saved-key",
            extra: { apiFormat: "anthropic" },
          },
        },
      },
      "test",
    );
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(declaration), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await route();
    const response = await app.request(
      "/provider-metrics/discover",
      request({
        providerId: "anthropic",
        baseUrl: "http://localhost:3000/kiro/v1",
        format: "anthropic",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      supported: true,
      fields: [
        expect.objectContaining({
          path: "usage.credit_unit",
          source: "declared",
          visible: false,
          accumulate: false,
        }),
        expect.objectContaining({
          path: "usage.credit_usage",
          type: "number",
          aggregation: "sum",
          unit: "credit",
          count: 0,
        }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/kiro/v1/usage-schema",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "x-api-key": "saved-key" }),
      }),
    );
    expect(
      JSON.stringify(
        await (
          await app.request("/provider-metrics?providerId=anthropic")
        ).json(),
      ),
    ).not.toContain("saved-key");
  });

  it("treats a missing schema as unsupported and retains observed fields", async () => {
    const m = await import("../../services/provider-metrics.js");
    m.observeProviderMetrics({
      providerId: "custom",
      requestId: "r",
      values: { "usage.energy": 2 },
    });
    const fetchMock = vi.fn(
      async (_url: string) => new Response("no schema", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await (
      await route()
    ).request(
      "/provider-metrics/discover",
      request({
        providerId: "custom",
        baseUrl: "http://localhost:3000/proxy",
        format: "openai",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      supported: false,
      fields: [
        expect.objectContaining({ path: "usage.energy", source: "observed" }),
      ],
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3000/proxy/usage-schema",
      "http://localhost:3000/proxy/v1/usage-schema",
    ]);
  });

  it.each(["openai", "openai-responses", "anthropic"])(
    "observes the already requested %s validation response without another model call",
    async (format) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                credit_usage: 0,
                credit_unit: "credit",
                input_tokens: 1,
                password: "hidden",
              },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const app = await route();
      const result = await app.request(
        "/ai-api/validate",
        request({
          providerId: "custom",
          baseUrl: "http://localhost:3000/v1",
          format,
          apiKey: "test",
          model: "model",
        }),
      );
      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { fields } = await (
        await app.request("/provider-metrics?providerId=custom")
      ).json();
      expect(fields).toHaveLength(2);
      expect(
        fields.find(
          (field: { path: string }) => field.path === "usage.credit_usage",
        ),
      ).toMatchObject({ lastValue: 0, count: 1, source: "observed" });
    },
  );

  it("persists numeric settings and limits returned values to the requested session", async () => {
    const m = await import("../../services/provider-metrics.js");
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "r1",
      sessionId: "s1",
      values: { "usage.energy": 1 },
    });
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "r2",
      sessionId: "s2",
      values: { "usage.energy": 3 },
    });
    const [field] = m.listProviderMetrics();
    const app = await route();
    const response = await app.request(
      "/provider-metrics",
      request(
        { id: field.id, visible: true, accumulate: true, sessionId: "s1" },
        "PATCH",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fields: [
        expect.objectContaining({
          total: 1,
          lastValue: 1,
          count: 1,
          visible: true,
          accumulate: true,
        }),
      ],
    });
    (await import("../../db/index.js")).closeDb();
    expect(
      await (await app.request("/provider-metrics?providerId=a")).json(),
    ).toMatchObject({
      fields: [
        expect.objectContaining({
          total: 4,
          count: 2,
          visible: true,
          accumulate: true,
        }),
      ],
    });
  });

  it("rejects oversized or invalid schemas and unsafe patches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(70_000), { status: 200 })),
    );
    const app = await route();
    expect(
      (
        await app.request(
          "/provider-metrics/discover",
          request({
            providerId: "custom",
            baseUrl: "http://localhost:3000/v1",
            format: "openai",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          "/provider-metrics",
          request({ id: "missing", accumulate: "true" }, "PATCH"),
        )
      ).status,
    ).toBe(400);
    expect(await (await app.request("/provider-metrics")).json()).toEqual({
      fields: [],
    });
  });
});
