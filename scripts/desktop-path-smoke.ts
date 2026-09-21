/** Packaged path regression: disposable data, real worktree, no model calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'Synax Path Smoke ')));
const repository = path.join(temp, '主项目 with spaces');
const worktree = path.join(temp, 'worktree with spaces');
const output = path.resolve('out/desktop-path-smoke.log');
const executablePath = process.argv[2] ?? path.resolve(
  `out/Synax-${process.platform}-${process.arch}/${process.platform === 'darwin' ? 'Synax.app/Contents/MacOS/Synax' : process.platform === 'win32' ? 'Synax.exe' : 'Synax'}`,
);
const env = { ...process.env, DATA_ROOT: path.join(temp, 'data') } as Record<string, string>;
if (process.platform !== 'win32') env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
let desktop: ElectronApplication | undefined;
let logs = '';
let base = '';
const git = (...args: string[]) => execFileSync('git', args, {
  cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
});
try {
  await mkdir(repository);
  git('init', '--quiet', '--initial-branch=main', '--template=');
  git('-c', 'user.name=Path Smoke', '-c', 'user.email=path@example.test', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '--quiet', '-b', 'path-smoke', worktree);
  await writeFile(path.join(worktree, 'worktree-only.txt'), 'Only in the selected worktree.\n');
  const probe = path.join(temp, 'path-probe.mjs');
  const source = await readFile(path.resolve('api/services/mcp/__tests__/fixtures/fake-mcp-server.mjs'), 'utf8');
  await writeFile(probe, `import { spawnSync } from 'node:child_process';\n` + source.replace(
    'description: "Echo text"',
    `description: JSON.stringify({ cwd: process.cwd(), versions: Object.fromEntries(['node', 'npx', 'rg'].map(command => {
      const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3000 });
      return [command, { status: result.status, error: result.error?.message, version: result.stdout?.split('\\n')[0] }];
    })) })`,
  ));
  desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${path.join(temp, 'profile')}`], env, timeout: 60000 });
  desktop.process().stdout?.on('data', data => { logs += data; });
  desktop.process().stderr?.on('data', data => { logs += data; });
  const page = await desktop.firstWindow({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.workbench-shell'), undefined, { timeout: 30000 });
  const bridge = await page.evaluate(async () => {
    const api = (window as any).electronAPI;
    return { port: await api.getApiPort(), token: await api.getRuntimeToken() };
  });
  base = `http://127.0.0.1:${bridge.port}`;
  async function request(route: string, body?: unknown, expected = 200): Promise<any> {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`);
    return value;
  }
  const config = { id: 'path-probe', name: 'Path probe', command: 'node', args: [probe], cwd: worktree };
  const explicit = await request('/api/mcp/test', config);
  const details = JSON.parse(explicit.tools.find((tool: any) => tool.name === 'echo').description);
  assert.equal(details.cwd, worktree);
  for (const [command, result] of Object.entries(details.versions) as [string, any][])
    assert.equal(result.status, 0, `${command}: ${JSON.stringify(result)}`);
  console.log('PASS GUI PATH resolves node/npx/rg; MCP cwd supports Unicode/spaces', details.versions);
  const { cwd: _cwd, ...globalConfig } = config;
  const global = await request('/api/mcp/test', globalConfig);
  assert.equal(JSON.parse(global.tools[0].description).cwd, await realpath(os.homedir()));
  const invalid = await request('/api/mcp/test', { ...config, command: './missing-plugin/server' }, 400);
  assert.match(invalid.error, /MCP executable.*cwd/);
  console.log('PASS global MCP never defaults to app Resources; bad relative commands report their base');

  const project = await request('/api/projects/workspaces', { name: 'Path smoke', roots: [{ localPath: repository }] }, 201);
  const created = await request('/api/agent-runtime/sessions', {
    projectId: project.project.id, profileId: 'synax', backendId: 'codex',
    prompt: 'Path smoke only; do not execute a model.', workDir: worktree,
  }, 201);
  const environment = await request(`/api/agent-runtime/sessions/${created.session.id}/environment`);
  assert.equal(environment.workspacePath, worktree);
  assert.equal(environment.branch, 'path-smoke');
  assert(environment.changedFiles.some((file: any) => file.path === 'worktree-only.txt'));
  assert.equal(git('status', '--porcelain').trim(), '');
  console.log('PASS selected worktree drives the packaged Git/environment view, not the primary checkout');
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, logs);
  try { await desktop?.close(); }
  finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
if (base) await assert.rejects(fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) }));
console.log('Desktop path smoke passed; sidecar stopped cleanly.');
