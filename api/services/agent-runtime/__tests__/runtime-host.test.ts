import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import NativeDatabase from 'libsql';
import { describe, expect, it } from 'vitest';
import { acquireRuntimeHost } from '../runtime-host.js';

describe('single runtime host ownership', () => {
  it('refuses another live owner without killing it or replacing the lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-host-'));
    const host = acquireRuntimeHost(root);
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      const db = new NativeDatabase(path.join(root, 'context.db'));
      db.prepare('UPDATE runtime_host_lock SET pid=? WHERE id=1').run(other.pid); db.close();
      expect(() => acquireRuntimeHost(root)).toThrow(/already owned/);
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
    } finally {
      const closed = new Promise<void>(resolve => other.once('close', () => resolve())); other.kill(); await closed;
      const reclaimed = acquireRuntimeHost(root); reclaimed.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
