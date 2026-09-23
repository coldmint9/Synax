/** Isolated browser acceptance: real Vite proxy + SharedWorker + authenticated WS.
 * Never opens the user's data directory or original browser profile. */
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";
import { installRuntimeAccess } from "../api/middleware/runtime-access.js";
import { ObservationTransport } from "../api/services/realtime/observation-transport.js";

const output = path.resolve(process.env.SYNAX_PERF_OUTPUT ?? ".tmp/performance-rollout/realtime-web-smoke.json");
const root = await mkdtemp(path.join(os.tmpdir(), "synax-realtime-smoke-"));
const app = new Hono();
const transport = new ObservationTransport(request => app.fetch(request));
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let revision = 1, connections = 0, maxConnections = 0, upgrades = 0;
const encoder = new TextEncoder();
let server: Server | undefined, browser: Browser | undefined, stopSockets: (() => void) | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
const report: Record<string, unknown> = { at: new Date().toISOString(), isolatedData: true };
const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
  const until = Date.now() + 15_000;
  while (!(await check())) { if (Date.now() > until) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); }
};
try {
  server = await new Promise<Server>(resolve => {
    const instance = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(instance as Server));
  });
  const backend = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stopSockets = transport.attach(server);
  server.on("upgrade", (request, socket) => {
    if (request.url !== "/api/realtime/socket") return;
    connections++; upgrades++; maxConnections = Math.max(maxConnections, connections);
    socket.on("close", () => connections--);
  });
  const html = `<!doctype html><title>Realtime acceptance</title><script type="module">
    import { AuthenticatedEventSource } from '/src/lib/api/authenticatedEventSource.ts';
    const r=await fetch('/api/auth/session',{method:'POST'});if(!r.ok)throw new Error('Auth failed');
    window.received={};window.sources=[];
    for(const [id,url]of [
      ['runtime','/api/agent-runtime/events/stream'],
      ['notifications','/api/notifications/stream?projectId=p'],
      ['context','/api/context/sync?projectId=p'],
      ['session','/api/agent-runtime/sessions/s/stream']]){
      window.received[id]=[];
      const source=new AuthenticatedEventSource(url);window.sources.push(source);
      source.addEventListener('snapshot',e=>window.received[id].push(JSON.parse(e.data).revision));
    }
    window.ready=true;
  </script>`;
  vite = await createServer({ configFile: false, root: path.resolve("web"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backend, changeOrigin: true, ws: true } } },
    plugins: [{ name: "realtime-acceptance", configureServer(v) {
      v.middlewares.use("/__realtime-smoke", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
    } }],
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  installRuntimeAccess(app, { dataRoot: root, webOrigins: [origin] });
  app.route("/api/realtime", transport.routes);
  app.get("/api/health", c => c.json({ ok: true }));
  app.get("/api/*", c => new Response(new ReadableStream<Uint8Array>({ start(stream) {
    streams.add(stream);
    const stop = () => { streams.delete(stream); try { stream.close(); } catch { /* already cancelled */ } };
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    if (c.req.raw.signal.aborted) { stop(); return; }
    stream.enqueue(encoder.encode(`id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify({ revision })}\n\n`));
  } }), { headers: { "Content-Type": "text/event-stream" } }));
  const executablePath = process.env.SYNAX_CHROME_PATH ??
    (existsSync(chromium.executablePath()) ? chromium.executablePath() : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const pages: Page[] = [], errors: string[] = [];
  const stages: unknown[] = [];
  for (let count = 1; count <= 4; count++) {
    const page = await context.newPage(); pages.push(page);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/__realtime-smoke`);
    await waitFor(() => page.evaluate(() => Object.values((window as any).received ?? {}).length === 4 && Object.values((window as any).received ?? {}).every((v: any) => v.length > 0)), `tab ${count} snapshots`);
    assert.equal(connections, 1, "All tabs must share one physical realtime socket");
    assert.equal(streams.size, 4 * count);
    const health = await page.evaluate(async () => {
      const times: number[] = [];
      for (let i = 0; i < 10; i++) { const start = performance.now(); const response = await fetch('/api/health'); await response.text(); if (!response.ok) throw new Error('Health failed'); times.push(performance.now() - start); }
      return times;
    });
    stages.push({ tabs: count, physicalSockets: connections, logicalObservations: streams.size, healthMs: health });
    assert(Math.max(...health) < 1000, "HTTP must not stall behind observations");
  }
  report.stages = stages;
  const soakMs = Number(process.env.SYNAX_PERF_SOAK_MS ?? 0);
  const soakDeadline = Date.now() + soakMs;
  const soakHealth: number[] = [];
  while (Date.now() < soakDeadline) {
    const ms = await pages[0].evaluate(async () => { const start = performance.now(); const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) }); await r.text(); if (!r.ok) throw new Error('Soak health failed'); return performance.now() - start; });
    soakHealth.push(ms);
    assert.equal(connections, 1); assert.equal(streams.size, 16);
    await new Promise(r => setTimeout(r, Math.min(5000, Math.max(0, soakDeadline - Date.now()))));
  }
  report.soak = { durationMs: soakMs, samples: soakHealth.length, healthMs: soakHealth };

  const beforeFocus = upgrades;
  for (let i = 0; i < 20; i++) await pages[0].evaluate(() => window.dispatchEvent(new Event('focus')));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(upgrades, beforeFocus, "Healthy focus must not reconnect");
  report.healthyFocusReconnects = upgrades - beforeFocus;
  revision = 2;
  globalThis.gc?.();
  await new Promise(r => setTimeout(r, 0));
  stopSockets(); stopSockets = transport.attach(server);
  await waitFor(async () => (await Promise.all(pages.map(p => p.evaluate(() => Object.values((window as any).received ?? {}).every((v: any) => v.at(-1) === 2))))).every(Boolean), "all four tabs recover snapshots after socket restart");
  assert.equal(connections, 1); assert.equal(streams.size, 16);
  await pages.pop()!.close();
  await waitFor(() => streams.size === 12, "closed tab releases observations");
  assert.equal(connections, 1, "Closing a tab must preserve other readers");
  for (const page of pages) await page.close();
  await waitFor(() => connections === 0 && streams.size === 0, "last tab closes socket and subscriptions");
  // No SharedWorker (older engines / app:// restrictions): still one WS per page,
  // never silently fall back to four HTTP/1.1 SSE streams.
  const fallback = await browser.newContext();
  await fallback.addInitScript(() => { Object.defineProperty(window, 'SharedWorker', { value: undefined }); });
  const fallbackPages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await fallback.newPage(); fallbackPages.push(page); await page.goto(`${origin}/__realtime-smoke`);
    await waitFor(() => page.evaluate(() => Object.values((window as any).received ?? {}).length === 4 && Object.values((window as any).received ?? {}).every((v: any) => v.length > 0)), 'per-page WS fallback');
  }
  assert.equal(connections, 2); assert.equal(streams.size, 8);
  report.fallback = { physicalSockets: connections, logicalObservations: streams.size };
  await fallback.close(); await waitFor(() => connections === 0 && streams.size === 0, 'fallback cleanup');
  assert.deepEqual(errors, []);
  report.restartRecovered = true; report.closedReadersReleased = true; report.maxPhysicalSockets = maxConnections;
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.passed = false; report.error = error instanceof Error ? error.stack : String(error); console.error(error); process.exitCode = 1; }
finally {
  await browser?.close(); stopSockets?.(); await vite?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await rm(root, { recursive: true, force: true });
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
}
