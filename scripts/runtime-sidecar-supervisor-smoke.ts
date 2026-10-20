import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'synax-runtime-supervisor-'));
const runtimeDir = join(root, 'runtime-sidecar');
const binary = join(process.cwd(), 'runtime-sidecar', 'target', 'release', process.platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar');
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'services/local-node/entrypoints/http-server.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    LOG_LEVEL: 'debug',
    DATA_ROOT: root,
    PORT: '0',
    SYNAX_DISABLE_READ_SERVICE: '1',
    SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '1',
    SYNAX_RUNTIME_SIDECAR_BIN: binary,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const cleanup = () => {
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
};
process.once('exit', cleanup);

try {
  const output: string[] = [];
  let port = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Node runtime supervisor startup timed out: ${output.join('\n')}`)), 30_000);
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      const match = text.match(/Server listening on http:\/\/localhost:(\d+)/);
      if (match) {
        port = Number(match[1]);
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Node runtime exited before READY (${code})\n${output.join('\n')}`)));
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error(`health returned ${response.status}`);
  const body = await response.text();
  if (!body.includes('ok')) throw new Error(`unexpected health body: ${body}`);
  // The sidecar now owns a JSONL store root (a `LOCK` file appears on open)
  // instead of the two RocksDB directories.
  const storePath = join(runtimeDir, 'jsonl');
  const lockPath = join(storePath, 'LOCK');
  const deadline = Date.now() + 5_000;
  while (!existsSync(lockPath) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (!existsSync(lockPath)) throw new Error('Rust sidecar jsonl store lock was not created');
  if (existsSync(join(runtimeDir, 'runtime-hot'))) throw new Error('the legacy RocksDB hot directory must not be created');
  console.log('node runtime supervisor startup smoke passed');
} finally {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(() => resolve(), 8_000).unref();
  });
  cleanup();
}
