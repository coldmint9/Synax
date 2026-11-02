/** Real runtime/browser acceptance for side chat and delegated subagents.
 * Run: npm run runtime-sidecar:build && npx tsx scripts/side-chat-smoke.ts
 * Uses disposable data, an HTTP/SSE provider fixture, and a fresh browser profile.
 * Screenshots and diagnostics stay outside the repository under /tmp by default.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { createServer as createViteServer, type ViteDevServer } from "vite";

type ProviderMessage = { role: string; content?: unknown; tool_calls?: unknown[] };
type ProviderRequest = {
  stream?: boolean;
  messages: ProviderMessage[];
  tools?: Array<{ function?: { name?: string } }>;
};
type FixtureTurn = {
  request: ProviderRequest;
  firstDeltaAt: number;
  finished: boolean;
  release: () => void;
  sendDelta: (value: string) => void;
};
type Session = {
  id: string;
  parentSessionId?: string | null;
  childSessionIds: string[];
  status: string;
  activeRunId?: string | null;
  sessionMetadata?: { subagentKind?: string; sideChatContext?: unknown };
};
type Run = { id: string; status: string; stopReason?: string };

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "synax-side-chat-"));
const reportDir = process.env.SYNAX_SIDE_CHAT_REPORT_DIR
  ? path.resolve(process.env.SYNAX_SIDE_CHAT_REPORT_DIR)
  : await mkdtemp(path.join(os.tmpdir(), "synax-side-chat-report-"));
const dataRoot = path.join(fixtureRoot, "data");
const workDir = path.join(fixtureRoot, "workspace");
const projectId = "side-chat-acceptance";
const historySecret = "PARENT_HISTORY_ANCHOR_739251";
const checks: string[] = [];
const turns = new Map<string, FixtureTurn>();
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const failedApis: string[] = [];
const historyReads: Array<{ path: string; status: number }> = [];
const summaryReads: Array<{ path: string; status: number }> = [];
let providerError: unknown;
let browser: Browser | undefined;
let page: Page | undefined;
let vite: ViteDevServer | undefined;
let host: ChildProcess | undefined;
let hostLog = "";
let base = "";
let token = "";
let failure: unknown;
let delegatedToolIssued = false;
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  isolatedData: true,
  browser: "playwright-core / Chromium",
  browserFallback: "Browser plugin not available; agent-browser CLI not installed",
  viewport: { width: 1560, height: 1000 },
};

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    if (providerError) throw providerError;
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 75));
  }
}

const provider = http.createServer((request, response) => {
  void (async () => {
    if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderRequest;
    const userText = JSON.stringify(body.messages.filter(message => message.role === "user").at(-1)?.content ?? "");
    const marker = ["SIDE_STREAM", "PARENT_STREAM", "DELEGATED_STREAM"].find(value => userText.includes(value));
    const shared = { id: `chatcmpl-side-chat-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: "gpt-4o-mini" };
    const send = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
      ...shared, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    const answer = marker ? `${marker} first fragment` : `History recorded: ${historySecret}`;
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ...shared, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    if (userText.includes("SPAWN_TASK") && !delegatedToolIssued) {
      const tool = body.tools?.find(candidate => candidate.function?.name === "subagent_delegate");
      assert(tool?.function?.name, "Parent provider must expose subagent.delegate to exercise real delegation");
      delegatedToolIssued = true;
      send({ role: "assistant", tool_calls: [{ index: 0, id: "side-chat-smoke-delegate", type: "function", function: {
        name: tool.function.name, arguments: JSON.stringify({ name: "Streaming task", prompt: "DELEGATED_STREAM: report one short sentence.", profile: { access: "read-only" } }),
      } }] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: answer });
      if (marker) {
        assert(!turns.has(marker), `Unexpected duplicate provider turn: ${marker}`);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const turn = { request: body, firstDeltaAt: Date.now(), finished: false, release,
          sendDelta: (value: string) => send({ content: value }) };
        turns.set(marker, turn);
        // The browser must observe the first fragment while this gate is closed.
        const timer = setTimeout(release, 180_000);
        await gate;
        clearTimeout(timer);
        send({ content: `; ${marker} complete.` });
        turn.finished = true;
      } else {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  })().catch(error => {
    providerError = error;
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/agent-runtime${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert(response.ok, `${endpoint}: ${response.status} ${JSON.stringify(result)}`);
  return result as T;
}

async function completeRun(sessionId: string, runId: string) {
  const run = await until(() => api<Run>(`/sessions/${sessionId}/runs/${runId}`),
    value => ["completed", "failed", "interrupted", "cancelled"].includes(value.status), "durable run completion");
  assert.equal(run.status, "completed", run.stopReason);
  const response = await fetch(`${base}/api/agent-runtime/sessions/${sessionId}/runs/${runId}/stream?realtime=1`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok);
  const body = await response.text();
  assert(body.includes('"type":"done"'), `Run must cross its durable finalization barrier: ${body.slice(-1500)}`);
}

async function stopHost() {
  const child = host;
  host = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); }
}

async function submit(composer: Locator, message: string) {
  const textarea = composer.locator("textarea:visible").first();
  await textarea.fill(message);
  await composer.locator(".agent-dock-composer-send:visible").click();
}

async function openSideChat() {
  await page!.locator('[data-side-chat-trigger="true"]').click();
  await page!.getByRole("button", { name: /在侧边聊天|Chat in side/ }).click();
}

async function visibleFragment(scope: Locator, marker: string) {
  await until(async () => (await scope.innerText()).includes(`${marker} first fragment`), Boolean, `${marker} visible before completion`);
  const turn = turns.get(marker);
  assert(turn && !turn.finished, `${marker} must render while the provider response is unfinished`);
  return Date.now() - turn.firstDeltaAt;
}

try {
  await Promise.all([mkdir(dataRoot), mkdir(workDir), mkdir(reportDir, { recursive: true })]);
  execFileSync("git", ["init", "-q", "--initial-branch=main", workDir]);
  await writeFile(path.join(workDir, "fixture.txt"), "Isolated side chat acceptance workspace.\n");
  execFileSync("git", ["-C", workDir, "add", "fixture.txt"]);
  execFileSync("git", ["-C", workDir, "-c", "user.name=Synax fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initialize acceptance fixture"]);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerPort = (provider.address() as { port: number }).port;
  process.env.DATA_ROOT = dataRoot;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";
  const { updateGlobalConfig } = await import("../services/local-node/infrastructure/runtime/config/config-store.js");
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: {
    openai: { providerId: "openai", apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${providerPort}/v1`, extra: { kind: "api", apiFormat: "openai", model: "gpt-4o-mini" } },
  } }, "side-chat-smoke");
  const at = new Date().toISOString();
  await writeFile(path.join(dataRoot, "projects.json"), JSON.stringify({ items: [{
    id: projectId, name: "Side chat acceptance", status: "healthy", environment: "development", importState: "ready",
    source: { kind: "localPath", localPath: workDir }, createdAt: at, updatedAt: at,
  }] }));
  const reservedPort = createTcpServer();
  reservedPort.listen(0, "127.0.0.1");
  await once(reservedPort, "listening");
  const webPort = (reservedPort.address() as { port: number }).port;
  await new Promise<void>(resolve => reservedPort.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {
    ...process.env, DATA_ROOT: dataRoot, PORT: "0", WEB_PORT: String(webPort), NODE_ENV: "test", LOG_LEVEL: "warn",
    SYNAX_DESKTOP_SIDECAR: "1", SYNAX_AGENT_SESSION_IN_PROCESS: "0",
    AGENT_SESSION_CHILD_READY_TIMEOUT_MS: "120000",
  };
  for (const key of ["SYNAX_HISTORY_MODE", "SYNAX_TRANSCRIPT_STORAGE", "SYNAX_RUNTIME_SIDECAR_STREAM", "SYNAX_RUNTIME_SIDECAR_ADMISSION", "SYNAX_RUNTIME_SIDECAR_SOCKET", "SYNAX_RUNTIME_SIDECAR_TOKEN", "SYNAX_RUNTIME_SIDECAR_PORT"]) delete env[key];
  host = spawn(process.execPath, ["--import", "tsx/esm", "services/local-node/entrypoints/http-server.ts"], {
    env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  host.stdout!.on("data", chunk => { hostLog += String(chunk); });
  host.stderr!.on("data", chunk => { hostLog += String(chunk); });
  const hostPort = await until(() => {
    assert.equal(host!.exitCode, null, `Host exited unexpectedly\n${hostLog.slice(-6000)}`);
    return /^SYNAX_DESKTOP_READY:(\d+)$/m.exec(hostLog)?.[1];
  }, Boolean, "runtime readiness");
  base = `http://127.0.0.1:${hostPort}`;
  console.log(`Runtime ready: ${base}`);
  token = (await readFile(path.join(dataRoot, "runtime-access-token"), "utf8")).trim();
  process.env.PORT = String(hostPort);
  vite = await createViteServer({
    configFile: path.resolve("client/vite.config.ts"), root: path.resolve("client"), logLevel: "error",
    server: { host: "127.0.0.1", port: webPort, strictPort: true, open: false },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${webPort}`;
  report.url = origin;
  const { session: parent } = await api<{ session: Session }>("/sessions", {
    projectId, profileId: "synax", prompt: "Side chat acceptance", workDir, permissionOverrides: { task: "allow" },
    sessionMetadata: { source: "session-page", mode: "chat" },
  });
  const seed = await api<{ run: Run }>(`/sessions/${parent.id}/runs`, {
    requestId: "side-chat-history", mode: "turn", message: `Remember the private conversation marker ${historySecret}.`,
  });
  await completeRun(parent.id, seed.run.id);
  console.log("Parent history ready; opening browser");
  checks.push("real parent history persisted");
  const executablePath = process.env.SYNAX_CHROME_PATH ?? (existsSync(chromium.executablePath())
    ? chromium.executablePath() : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", event => { if (event.type() === "error") consoleErrors.push(`${event.text()} ${event.location().url}`); });
  page.on("response", response => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.includes("/api/") && response.status() >= 500) failedApis.push(`${response.status()} ${response.url()}`);
    if (pathname.endsWith("/history-window")) historyReads.push({ path: pathname, status: response.status() });
    if (pathname.endsWith("/summary")) summaryReads.push({ path: pathname, status: response.status() });
  });
  const sessionUrl = `${origin}/projects/${projectId}/sessions?session=${encodeURIComponent(parent.id)}`;
  await page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /继续离线使用|Continue offline/ }).click();
  console.log("Offline entry selected");
  await page.locator(".workbench-shell").waitFor();
  await page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-side-chat-trigger="true"]').waitFor();
  console.log("Main conversation controls ready");
  await until(() => page!.locator(".session-list-item:not(.session-list-item--child)").count(), value => value === 1, "one root session in sidebar");
  assert.equal(new URL(page.url()).searchParams.get("session"), parent.id);
  assert((await page.title()).length > 0, "Document title must be present");
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  checks.push("page identity, nonblank workbench, no framework overlay");

  const createdResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${parent.id}/side-chat`));
  await openSideChat();
  const created = await (await createdResponse).json() as { session: Session };
  const side = created.session;
  assert(side?.id, JSON.stringify(created));
  assert.equal(side.parentSessionId, parent.id);
  assert.equal(side.sessionMetadata?.subagentKind, "side-chat");
  console.log("Side chat child ready");
  const panel = page.locator(".side-chat");
  await panel.locator("textarea:visible").waitFor();
  const roots = await api<{ items: Session[] }>(`/sessions?projectId=${projectId}`);
  assert.deepEqual(roots.items.map(item => item.id), [parent.id]);
  assert.equal(await page.locator(".session-list-item:not(.session-list-item--child)").count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("session"), parent.id);
  checks.push("side chat is a child; root list and main selection unchanged");

  const sideAcceptedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${side.id}/runs`));
  await submit(panel, "SIDE_STREAM: what marker did I tell the main conversation?");
  const sideRun = await (await sideAcceptedResponse).json() as { run: Run };
  await until(() => turns.has("SIDE_STREAM"), Boolean, "side provider request");
  assert(JSON.stringify(turns.get("SIDE_STREAM")!.request.messages).includes(historySecret), "Side provider must receive the main history snapshot");
  const sideLatency = await visibleFragment(panel, "SIDE_STREAM");
  console.log(`Side fragment rendered before completion (${sideLatency} ms)`);
  report.sideFirstDeltaVisibleMs = sideLatency;
  checks.push("snapshot reaches the provider; side first fragment renders before completion");
  // The primary composer is outside the side panel and remains independently usable.
  const primaryComposer = page.locator('.agent-session-controls:not(.side-chat .agent-session-controls)').filter({ visible: true }).first();
  assert.equal(await primaryComposer.evaluate(element => Boolean(element.closest(".side-chat"))), false);
  const parentAcceptedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/sessions/${parent.id}/runs`));
  await submit(primaryComposer, "PARENT_STREAM: continue the main conversation while side chat runs.");
  const concurrentRun = await (await parentAcceptedResponse).json() as { run: Run };
  await until(async () => {
    const run = await api<Run>(`/sessions/${parent.id}/runs/${concurrentRun.run.id}`);
    assert(!["failed", "interrupted", "cancelled"].includes(run.status), `Concurrent parent failed: ${run.stopReason}`);
    return turns.has("PARENT_STREAM");
  }, Boolean, "concurrent parent provider request");
  const parentLatency = await visibleFragment(page.locator(".session-chat").first(), "PARENT_STREAM");
  assert(!turns.get("SIDE_STREAM")!.finished && !turns.get("PARENT_STREAM")!.finished);
  assert(!(await panel.innerText()).includes("PARENT_STREAM first fragment"), "Main deltas must not enter the side transcript");
  report.firstDeltaVisibleMs = { sideChat: sideLatency, parent: parentLatency };
  await page.screenshot({ path: path.join(reportDir, "concurrent-streaming.png") });
  checks.push("primary deltas stay out of the side chat; parent and side first fragments visible before either response finishes");
  turns.get("SIDE_STREAM")!.release();
  turns.get("PARENT_STREAM")!.release();
  await Promise.all([
    completeRun(side.id, sideRun.run.id),
    completeRun(parent.id, concurrentRun.run.id),
  ]);
  await until(async () => (await panel.innerText()).includes("SIDE_STREAM complete."), Boolean, "side final history");
  // The inherited snapshot is model context only: scrolling to the top of the
  // side transcript must never reveal the primary conversation.
  await panel.locator(".session-workspace-scroll").first().evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(300);
  assert(!(await panel.innerText()).includes(historySecret), "Side chat must not display the inherited snapshot");
  await panel.locator(".side-chat-close").click();
  await openSideChat();
  await until(async () => (await panel.innerText()).includes("SIDE_STREAM complete."), Boolean, "side chat reopened with preserved conversation");
  await panel.locator(".session-workspace-scroll").first().evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(300);
  assert(!(await panel.innerText()).includes(historySecret), "Reopened side chat must not display the inherited snapshot");
  const reused = await api<{ session: Session; reused: boolean }>(`/sessions/${parent.id}/side-chat`, {});
  assert.equal(reused.session.id, side.id, "Reopen must reuse the existing side child after parent history advances");
  assert.equal(reused.reused, true);
  checks.push("snapshot stays hidden in the side transcript; close/reopen preserves side child despite newer parent history");

  await panel.locator(".side-chat-close").click();
  const delegated = await api<{ run: Run }>(`/sessions/${parent.id}/runs`, {
    requestId: "side-chat-delegation", mode: "turn", message: "SPAWN_TASK: start the named delegated streaming test task.",
  });
  await until(() => turns.has("DELEGATED_STREAM"), Boolean, "delegated task provider request");
  await page.locator(".subagent-island-trigger").waitFor();
  await page.locator(".subagent-island-trigger").click();
  await page.locator(".subagent-island-row").filter({ hasText: "Streaming task" }).click();
  const taskPanel = page.locator(".subagent-conversation");
  await visibleFragment(taskPanel, "DELEGATED_STREAM");
  // Discovery of the child in the parent island may happen after its initial
  // delta. Verify a fresh delta after the viewer mounts, not only replay.
  const delegatedDeltaAt = Date.now();
  turns.get("DELEGATED_STREAM")!.sendDelta("; DELEGATED_LIVE_UPDATE");
  await until(async () => (await taskPanel.innerText()).includes("DELEGATED_LIVE_UPDATE"), Boolean, "fresh delegated delta after viewer mount");
  assert(!turns.get("DELEGATED_STREAM")!.finished);
  report.delegatedLiveDeltaVisibleMs = Date.now() - delegatedDeltaAt;
  await page.screenshot({ path: path.join(reportDir, "delegated-streaming.png") });
  turns.get("DELEGATED_STREAM")!.release();
  await completeRun(parent.id, delegated.run.id);
  await until(async () => (await taskPanel.innerText()).includes("DELEGATED_STREAM complete."), Boolean, "delegated final history");
  checks.push("real delegated subagent uses the same realtime viewer; first delta and final history render");
  await page.screenshot({ path: path.join(reportDir, "completed.png") });
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedApis, []);
  // Generation changes intentionally reject stale cursors; only accept the
  // console's 409 noise if a later successful history fetch proves recovery.
  for (const [index, read] of historyReads.entries()) {
    if (read.status === 409) await until(() => historyReads.slice(index + 1).some(next => next.path === read.path && next.status === 200),
      Boolean, `History cursor conflict must recover: ${read.path}`, 15_000);
  }
  for (const [index, read] of summaryReads.entries()) {
    if (read.status === 404) await until(() => summaryReads.slice(index + 1).some(next => next.path === read.path && next.status === 200),
      Boolean, `Child summary creation race must recover: ${read.path}`, 15_000);
  }
  assert.deepEqual(consoleErrors.filter(error => !error.includes("favicon") &&
    !(error.includes("409 (Conflict)") && error.includes("/history-window?")) &&
    !(error.includes("404 (Not Found)") && error.endsWith("/summary"))), []);
  checks.push("no browser exceptions, unhandled console errors, failed API requests, or framework overlay; any stale history cursor recovers");
} catch (error) {
  failure = error;
  if (page) {
    await page.screenshot({ path: path.join(reportDir, "failure.png") }).catch(() => undefined);
    await writeFile(path.join(reportDir, "failure-dom.txt"), await page.locator("body").innerText().catch(() => "Page unavailable"));
  }
} finally {
  for (const turn of turns.values()) turn.release();
  await browser?.close();
  await vite?.close();
  await stopHost();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  const runtimeFailures = hostLog.split("\n").filter(line =>
    /STALE_EPOCH|session epoch is stale|persistence failure|execution ended with an error|authoritative stream stopped/i.test(line));
  if (!failure) {
    try {
      assert.deepEqual(runtimeFailures, [], "Completed browser flows must not hide runtime epoch or persistence failures");
      checks.push("no stale session epoch, execution, or persistence failures in runtime logs");
    } catch (error) { failure = error; }
  }
  Object.assign(report, {
    passed: !failure, checks, pageErrors, consoleErrors, failedApis,
    runtimeFailures,
    recoveredHistoryConflicts: historyReads.filter(read => read.status === 409).length,
    error: failure instanceof Error ? failure.stack : failure ? String(failure) : null,
    fixture: failure ? fixtureRoot : undefined,
    providerRequests: [...turns].map(([marker, turn]) => ({ marker, finished: turn.finished })),
  });
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "host.log"), hostLog);
  await writeFile(path.join(reportDir, "result.json"), JSON.stringify(report, null, 2));
  if (!failure) await rm(fixtureRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, reportDir }, null, 2));
if (failure) process.exitCode = 1;
