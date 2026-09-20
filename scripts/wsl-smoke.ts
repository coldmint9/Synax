import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeWslPath, listWslDistributions, runWsl } from '../api/services/wsl.js';
import { workspaceLocationHostPath } from '../api/services/workspace-location.js';

async function main(): Promise<void> {
  if (process.env.SYNAX_WSL_SMOKE !== '1') {
    console.log('WSL2 smoke skipped; set SYNAX_WSL_SMOKE=1 on a Windows WSL2 host.');
    return;
  }
  if (process.platform !== 'win32') throw new Error('WSL2 smoke requires Windows.');
  const distributions = await listWslDistributions();
  const distribution = process.env.SYNAX_WSL_DISTRIBUTION
    ?? distributions.find(item => item.default)?.name
    ?? distributions[0]?.name;
  if (!distribution) throw new Error('No WSL2 distribution is available.');
  const directory = `/tmp/synax-wsl-smoke-${Date.now()}`;
  try {
    await runWsl(distribution, '/', '/bin/sh', ['-c', 'mkdir -p "$1" && cd "$1" && git init -q && printf smoke > smoke.txt', 'synax', directory]);
    const canonical = await canonicalizeWslPath(distribution, directory);
    const hostPath = workspaceLocationHostPath({ kind: 'wsl', distribution, path: canonical });
    if ((await fs.readFile(path.join(hostPath, 'smoke.txt'), 'utf8')) !== 'smoke') throw new Error('UNC file bridge returned unexpected content.');
    const status = await runWsl(distribution, canonical, 'git', ['status', '--porcelain']);
    if (!status.stdout.includes('smoke.txt')) throw new Error('WSL Git did not see the smoke file.');
    console.log(`WSL2 smoke passed: ${distribution} · ${canonical}`);
  } finally {
    await runWsl(distribution, '/', 'rm', ['-rf', '--', directory]).catch(() => undefined);
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
