/** Packaged UI + real runtime + deterministic local provider. No paid model calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";

const temp = await mkdtemp(path.join(os.tmpdir(), "synax-metrics-smoke-"));
const output = path.resolve("out/provider-metrics-smoke");
await mkdir(output, { recursive: true });
const providerId = "custom-api:metrics-smoke";
let calls = 0;
let schemaCalls = 0;
const provider = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/usage-schema") {
    schemaCalls++;
    res.end(
      JSON.stringify({
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
      }),
    );
    return;
  }
  if (req.url === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: "metrics-smoke" }] }));
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  calls++;
  const id = `chatcmpl-${calls}`;
  const usage = {
    prompt_tokens: 12,
    completion_tokens: 2,
    total_tokens: 14,
    credit_usage: 0.25,
    credit_unit: "credit",
    diagnostics: { cached: true, latency_ms: 25 },
  };
  if (!input.stream) {
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: 1,
        model: "metrics-smoke",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Metrics verified." },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
    );
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  const send = (value: object) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "metrics-smoke", ...value })}\n\n`,
    );
  send({
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Metrics verified." },
        finish_reason: null,
      },
    ],
    usage: { credit_usage: 0.125 },
  });
  send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env = { ...process.env, DATA_ROOT: path.join(temp, "data") } as Record<
  string,
  string
>;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
let app: ElectronApplication | undefined;
let page: Page;
let logs = "";
const executablePath =
  process.argv[2] ??
  path.resolve("out/Synax-darwin-arm64/Synax.app/Contents/MacOS/Synax");
const errors: string[] = [];
async function launch() {
  app = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(temp, "profile")}`],
    env,
    timeout: 60_000,
  });
  app.process().stdout?.on("data", (data) => {
    logs += data;
  });
  app.process().stderr?.on("data", (data) => {
    logs += data;
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".workbench-shell");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 960);
    w.setTitle("Synax — Metrics QA");
  });
}
async function api(
  route: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  return page.evaluate(
    async ({ route, method, body }) => {
      const bridge = (window as any).electronAPI;
      const response = await fetch(
        `http://127.0.0.1:${await bridge.getApiPort()}${route}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${await bridge.getRuntimeToken()}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const json = await response.json();
      if (!response.ok)
        throw new Error(`${route}: ${response.status} ${JSON.stringify(json)}`);
      return json;
    },
    { route, method, body },
  );
}
async function navigate(route: string) {
  await app!.evaluate(
    ({ BrowserWindow }, route) =>
      BrowserWindow.getAllWindows()[0].webContents.send("menu:navigate", route),
    route,
  );
}
async function until<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 45_000;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
try {
  await launch();
  const importHint = page.getByRole("button", { name: "关闭导入提示" });
  if (await importHint.count()) await importHint.click();
  const { config } = await api("/api/config/global");
  await api("/api/config/global", "PUT", {
    providers: [
      ...config.providers,
      {
        id: providerId,
        label: "Metrics Smoke",
        kind: "api",
        status: "live",
        caps: { canFollowUp: true, canCancel: true },
        models: [
          {
            id: "metrics-smoke",
            label: "Metrics Smoke",
            isDefault: true,
            contextLimit: 128000,
          },
        ],
      },
    ],
    defaultApiProviderId: providerId,
    providerConnections: {
      [providerId]: {
        providerId,
        baseUrl,
        apiKey: "fixture-only",
        extra: { kind: "api", apiFormat: "openai", model: "metrics-smoke" },
      },
    },
  });
  await navigate("/settings");
  await page.getByText("Metrics Smoke", { exact: true }).first().waitFor();
  // Opening a configured provider discovers its supported fields without generation.
  const card = page
    .locator(".settings-item")
    .filter({ hasText: "Metrics Smoke" });
  await card.getByRole("button", { name: /Metrics Smoke/ }).click();
  await card.getByRole("button", { name: /编辑|Edit/ }).click();
  await until(
    () =>
      api(
        `/api/config/provider-metrics?providerId=${encodeURIComponent(providerId)}`,
      ),
    (x) => x.fields.length >= 2,
  );
  assert.equal(calls, 0, "schema discovery must not generate a model response");
  assert(schemaCalls > 0);
  await page
    .getByRole("dialog")
    .getByRole("region", { name: "扩展参数" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "01-provider-discovery.png"),
  });
  await page.keyboard.press("Escape");

  const workspace = path.join(temp, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "README.md"), "# Metrics test\n");
  const project = await api("/api/projects/workspaces", "POST", {
    name: "Metrics QA",
    roots: [{ localPath: workspace }],
  });
  const created = await api("/api/agent-runtime/sessions", "POST", {
    projectId: project.project.id,
    profileId: "synax",
    model: `${providerId}/metrics-smoke`,
    prompt: "Say Metrics verified.",
    workDir: workspace,
    sessionMetadata: { mode: "chat", source: "session-page" },
  });
  const sessionId = created.session.id;
  await api(`/api/agent-runtime/sessions/${sessionId}/runs`, "POST", {
    requestId: randomUUID(),
    message: "Say Metrics verified.",
    model: `${providerId}/metrics-smoke`,
    maxTokens: 64,
  });
  const metrics = await until(
    () => api(`/api/config/provider-metrics?sessionId=${sessionId}`),
    (x) =>
      x.fields.some((f: any) => f.path === "usage.credit_usage" && f.count > 0),
  );
  const credit = metrics.fields.find(
    (f: any) => f.path === "usage.credit_usage",
  );
  assert.equal(
    credit.lastValue,
    0.25,
    "stream usage snapshots must use the last value",
  );
  assert(
    metrics.fields.some(
      (f: any) => f.path === "usage.diagnostics.cached" && f.lastValue === true,
    ),
    "unknown nested boolean is discovered",
  );
  await until(
    () => api(`/api/agent-runtime/sessions/${sessionId}`),
    (x) => !["running", "queued"].includes(x.session.status),
  );
  await navigate(
    `/projects/${project.project.id}/sessions?session=${sessionId}`,
  );
  await page.waitForSelector(".work-page");
  await page.getByRole("button", { name: "运行详情", exact: true }).click();
  await page.getByRole("button", { name: "添加参数", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "显示 Credits", exact: true })
    .click();
  await until(
    () => api(`/api/config/provider-metrics?sessionId=${sessionId}`),
    (x) => x.fields.some((f: any) => f.id === credit.id && f.visible),
  );
  await page
    .getByRole("checkbox", { name: "累计 Credits", exact: true })
    .click();
  const before = await until(
    () => api(`/api/config/provider-metrics?sessionId=${sessionId}`),
    (x) =>
      x.fields.some(
        (f: any) => f.id === credit.id && f.visible && f.accumulate,
      ),
  );
  const recorded = before.fields.find((f: any) => f.id === credit.id);
  assert.equal(
    recorded.total,
    recorded.count * 0.25,
    "one sample per physical request, no repeated snapshot addition",
  );
  await page.getByRole("button", { name: "收起参数选择", exact: true }).click();
  await page.getByText("Credits", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, "02-runtime-credits.png") });
  await until(
    () => api(`/api/agent-runtime/sessions/${sessionId}`),
    (x) => !["running", "queued"].includes(x.session.status),
  );
  await app!.close();
  app = undefined;
  await launch();
  const after = await api(
    `/api/config/provider-metrics?sessionId=${sessionId}`,
  );
  const persisted = after.fields.find((f: any) => f.id === credit.id);
  assert.equal(persisted.visible, true);
  assert.equal(persisted.accumulate, true);
  assert.equal(persisted.total, recorded.total);
  assert.equal(
    persisted.count,
    recorded.count,
    "restart must not re-add saved samples",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      calls,
      schemaCalls,
      recorded: {
        path: recorded.path,
        count: recorded.count,
        total: recorded.total,
      },
      output,
    }),
  );
} finally {
  if (page!)
    await page
      .screenshot({ path: path.join(output, "last-state.png") })
      .catch(() => {});
  await app?.close().catch(() => {});
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await writeFile(path.join(output, "desktop.log"), logs);
  await rm(temp, { recursive: true, force: true });
}
