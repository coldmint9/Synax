import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it, vi } from 'vitest';

describe('real host crash recovery', () => {
  it.skipIf(process.platform === 'win32')('reclaims only identified child groups, fences old work and requires explicit review', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-crash-integration-'));
    const parent = spawn(process.execPath, ['--import', 'tsx/esm', path.resolve('api/services/agent-runtime/__tests__/fixtures/crash-host.ts')], {
      env: { ...process.env, DATA_ROOT: root, LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; parent.stderr.on('data', data => { stderr += data; });
    const lines = createInterface({ input: parent.stdout });
    let host: { release(): void } | undefined;
    try {
      const info = await new Promise<{ sessionId: string; pid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${stderr}`)), 10000);
        parent.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
        lines.on('line', line => { try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value); } } catch {} });
      });
      const gone = new Promise<void>(resolve => parent.once('close', () => resolve())); parent.kill('SIGKILL'); await gone;
      vi.stubEnv('DATA_ROOT', root); vi.resetModules();
      const { acquireRuntimeHost } = await import('../runtime-host.js');
      const lease = acquireRuntimeHost(root); host = lease;
      vi.stubEnv('SYNAX_RUNTIME_HOST_ID', lease.hostId); vi.stubEnv('SYNAX_RUNTIME_DATA_ROOT', root);
      const { recoverRuntime } = await import('../runtime-recovery.js');
      const { agentRuntimeStore } = await import('../session-store.js');
      await recoverRuntime(lease.hostId);
      const recovered = agentRuntimeStore.getSession(info.sessionId);
      expect(recovered.status).toBe('interrupted');
      expect(recovered.activeRunId).toBeNull();
      expect(recovered.pendingResumeToken).toBeNull();
      expect(recovered.blockedReason).toMatch(/interrupted/i);
      expect(agentRuntimeStore.getRun('crash-run').status).toBe('interrupted');
      expect(() => process.kill(info.pid, 0)).toThrow();
      expect(fs.existsSync(path.join(root, 'workspace', 'must-not-finish.txt'))).toBe(false);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      lines.close();
      const { closeDb } = await import('../../../db/index.js'); closeDb();
      host?.release(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
