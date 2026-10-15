import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'synax-runtime-node-authoritative-'));
const socketPath = join(root, 'runtime.sock');
const hotPath = join(root, 'runtime-hot');
const binary = join(process.cwd(), 'runtime-sidecar', 'target', 'release', process.platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar');
const token = 'node-authoritative-smoke-token';
const child = spawn(binary, [], {
  env: {
    ...process.env,
    SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
    SYNAX_RUNTIME_SIDECAR_TOKEN: token,
    SYNAX_RUNTIME_HOT_PATH: hotPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const cleanup = () => {
  if (child.exitCode === null) child.kill('SIGKILL');
  try { unlinkSync(socketPath); } catch {}
  rmSync(root, { recursive: true, force: true });
};
process.once('exit', cleanup);

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar READY timeout')), 10_000);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split('\n').find((value) => value.startsWith('SYNAX_RUNTIME_READY:'));
      if (!line) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`sidecar exited before READY (${code})`)));
  });

  process.env.SYNAX_RUNTIME_SIDECAR_SOCKET = socketPath;
  process.env.SYNAX_RUNTIME_SIDECAR_TOKEN = token;
  process.env.SYNAX_RUNTIME_SIDECAR_STREAM = 'authoritative';

  const { runtimeFacade } = await import('../services/local-node/modules/agent-runtime/sidecar/runtime-facade.ts');
  await runtimeFacade.appendStreamAuthoritative({
    sessionId: 'node-session',
    runId: 'node-run',
    producerId: 'node-producer',
    producerSequence: 1,
    epoch: 1,
    revision: 0,
    chunks: [
      { type: 'message_delta', runId: 'node-run', stepId: 'node-step', delta: 'hello from node' },
      { type: 'done', sessionId: 'node-session', runId: 'node-run' },
    ],
  });
  const replay = await runtimeFacade.replayAuthoritative('node-session', 0, 'node-run');
  if (replay.length !== 2) throw new Error(`expected 2 sidecar events, got ${replay.length}`);
  const first = JSON.parse(Buffer.from(replay[0].payload).toString('utf8')) as { type?: string; delta?: string };
  if (replay[0].sequence !== 1 || first.type !== 'message_delta' || first.delta !== 'hello from node')
    throw new Error(`unexpected authoritative replay: ${JSON.stringify({ sequence: replay[0].sequence, first })}`);
  if (replay[1].sequence !== 2) throw new Error(`unexpected second sequence: ${replay[1].sequence}`);
  console.log('node authoritative stream smoke passed');
} finally {
  child.kill('SIGINT');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(() => resolve(), 5_000).unref();
  });
  cleanup();
}
