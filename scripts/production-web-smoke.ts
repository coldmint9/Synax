/** Full production Web entry acceptance. All runtime writes use a disposable DATA_ROOT.
 * Chromium pins only this test certificate's SPKI; system/browser trust is untouched. */
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'synax-production-web-'));
const output = path.resolve(process.env.SYNAX_PERF_OUTPUT ?? '.tmp/performance-rollout/production-web-smoke.json');
const report: Record<string, any> = { at: new Date().toISOString(), isolatedData: true };
let child: ChildProcess | undefined, browser: Browser | undefined, logs = '';
const waitFor = async (check: () => boolean | Promise<boolean>, label: string, ms = 45_000) => {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${logs.slice(-5000)}`); await new Promise(r => setTimeout(r, 100)); }
};
try {
  const portServer = createServer(); await new Promise<void>(r => portServer.listen(0, '127.0.0.1', r));
  const port = (portServer.address() as { port: number }).port; await new Promise<void>(r => portServer.close(() => r()));
  const config = path.join(root, 'openssl.cnf'), certFile = path.join(root, 'cert.pem'), keyFile = path.join(root, 'key.pem');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-config', config], { stdio: 'ignore' });
  const cert = await readFile(certFile);
  const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const data = path.join(root, 'data'), repo = path.join(root, 'repo'); await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(path.join(repo, 'hello.txt'), 'isolated acceptance fixture\n');
  await mkdir(data);
  await writeFile(path.join(data, 'projects.json'), JSON.stringify({ items: [{ id: 'perf-project', name: 'Performance acceptance', status: 'healthy', environment: 'development', importState: 'ready', source: { kind: 'localPath', localPath: repo }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/start-web.ts'], { cwd: process.cwd(), env: { ...process.env, DATA_ROOT: data, WEB_PORT: String(port), WEB_TLS_CERT: certFile, WEB_TLS_KEY: keyFile, SYNAX_API_ORIGIN: '', LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', b => { logs += b }); child.stderr!.on('data', b => { logs += b });
  await waitFor(() => { if (child!.exitCode !== null) throw new Error(`start:web exited ${child!.exitCode}\n${logs}`); return logs.includes('[start:web] https://'); }, 'production readiness', 120_000);
  const origin = `https://localhost:${port}`;
  const health = await new Promise<any>((resolve, reject) => https.get(`${origin}/api/health`, { ca: cert }, response => {
    let body = ''; response.on('data', b => { body += b }); response.on('end', () => resolve({ version: response.httpVersion, data: JSON.parse(body) }));
  }).on('error', reject));
  assert.equal(health.version, '1.1'); assert.equal(health.data.capabilities.realtime, 1);
  browser = await chromium.launch({ executablePath: process.env.SYNAX_CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  const context = await browser.newContext();
  const protocols: Record<string, string> = {}, pageErrors: string[] = [], failedApis: string[] = [];
  const pages = [];
  const first = await context.newPage(); pages.push(first);
  const cdp = await context.newCDPSession(first); await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', e => { protocols[new URL(e.response.url).pathname] = e.response.protocol; if (e.response.url.includes('/api/') && e.response.status >= 500) failedApis.push(`${e.response.status} ${e.response.url}`); });
  first.on('pageerror', e => pageErrors.push(e.message));
  await first.goto(origin);
  await waitFor(async () => (await context.cookies()).some(cookie => cookie.name.startsWith('synax_runtime_')), 'automatic runtime cookie');
  const cookie = (await context.cookies()).find(cookie => cookie.name.startsWith('synax_runtime_'))!;
  assert(cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
  const session = await first.evaluate(async () => {
    const response = await fetch('/api/agent-runtime/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'perf-project', profileId: 'synax', backendId: 'codex', prompt: 'Performance acceptance; do not execute' }) });
    const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body.session;
  });
  const url = `${origin}/projects/perf-project/sessions?session=${encodeURIComponent(session.id)}`;
  await first.goto(url);
  await waitFor(() => first.locator('.workbench-shell').isVisible(), 'production workbench');
  for (let i = 1; i < 4; i++) { const page = await context.newPage(); pages.push(page); page.on('pageerror', e => pageErrors.push(e.message)); await page.goto(url); await waitFor(() => page.locator('.workbench-shell').isVisible(), `workbench tab ${i + 1}`); }
  await waitFor(() => context.serviceWorkers().length === 0, 'no service-worker interference');
  const latency = await first.evaluate(async () => {
    const result: number[] = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); const response = await fetch('/api/health', { signal: AbortSignal.timeout(2000) }); await response.text(); if (!response.ok) throw new Error('health failed'); result.push(performance.now() - start); }
    return result;
  });
  assert.equal(protocols['/'], 'h2'); assert.equal(protocols['/api/health'], 'h2');
  assert(Object.entries(protocols).some(([name, protocol]) => name.endsWith('.js') && protocol === 'h2'));
  // CDP inspects the worker's socket count without depending on a UI-only debug endpoint.
  const browserCdp = await browser.newBrowserCDPSession();
  const targets = await browserCdp.send('Target.getTargets');
  const workers = targets.targetInfos.filter(t => t.type === 'shared_worker' && t.url.includes('shared-worker'));
  assert.equal(workers.length, 1, 'four app tabs share the observation worker');
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedApis, []);
  latency.sort((a,b) => a-b);
  report.http2 = { document: protocols['/'], health: protocols['/api/health'], jsAssets: Object.entries(protocols).filter(([name]) => name.endsWith('.js')).length };
  report.http1Fallback = health.version;
  report.tabs = 4; report.sharedWorkers = workers.length; report.cookie = { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite };
  report.health = { samples: latency.length, p95Ms: latency[18], maxMs: latency.at(-1) };
  report.pageErrors = pageErrors; report.failedApis = failedApis;
  await browser.close(); browser = undefined;
  child.kill('SIGTERM'); await waitFor(() => child!.exitCode !== null || child!.signalCode !== null, 'production shutdown', 15_000);
  const owner = logs.match(/SYNAX_DESKTOP_READY:(\d+)/)?.[1];
  if (owner) {
    let listening = true; try { await fetch(`http://127.0.0.1:${owner}/api/health`, { signal: AbortSignal.timeout(1000) }); } catch { listening = false; }
    assert.equal(listening, false, 'owned backend must stop with the gateway');
  }
  report.shutdown = true; report.passed = true;
} catch (error) { report.passed = false; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(r => { const t = setTimeout(() => { child?.kill('SIGKILL'); r() }, 10_000); child!.once('exit', () => { clearTimeout(t); r() }); }); }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2)); await writeFile(output.replace(/\.json$/, '.log'), logs);
  // Keep failed fixture for diagnosis; successful fixture contains no user data and is removed.
  if (report.passed) await rm(root, { recursive: true, force: true }); else report.fixture = root;
  console.log(JSON.stringify(report, null, 2));
}
