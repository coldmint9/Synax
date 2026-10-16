import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('selects the single storage owner for an explicitly disabled sidecar test host before startup maintenance opens the database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-host-startup-'));
  const env = { ...process.env, DATA_ROOT: root, PORT: '0', NODE_ENV: 'production', LOG_LEVEL: 'error', SYNAX_DESKTOP_SIDECAR: '1', SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '0', SYNAX_RUNTIME_SIDECAR_STREAM: 'disabled' };
  for (const key of Object.keys(env)) if (key.startsWith('SYNAX_STORAGE_OWNER_') || key === 'SYNAX_RUNTIME_HOST_ID' || key === 'SYNAX_RUNTIME_DATA_ROOT' || key === 'VITEST') delete env[key as keyof typeof env];
  const server = fileURLToPath(new URL('./http-server.ts', import.meta.url));
  const database = fileURLToPath(new URL('../infrastructure/database/index.ts', import.meta.url));
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    await import(${JSON.stringify(server)});
    const {getRawSqlite}=await import(${JSON.stringify(database)});
    const db=getRawSqlite();
    if(!process.env.SYNAX_STORAGE_OWNER_ENDPOINT || typeof db.executeStatement !== 'function') throw Error('Host bypassed storage owner');
    db.exec('CREATE TABLE startup_probe(id INTEGER PRIMARY KEY)');
    db.transaction(()=>db.prepare('INSERT INTO startup_probe VALUES (1), (2) RETURNING id').run())();
    console.log('OWNER_READY');
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(resolve => proc.once('exit', resolve));
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Startup timed out: ${output.slice(-3000)}`)), 20_000);
      proc.on('error', error => { clearTimeout(timer); reject(error); });
      proc.on('exit', code => { clearTimeout(timer); reject(Error(`Startup exited ${code}: ${output.slice(-3000)}`)); });
      const read = (data: Buffer) => {
        output += data;
        if (output.includes('OWNER_READY') && output.includes('SYNAX_DESKTOP_READY:')) { clearTimeout(timer); resolve(); }
      };
      proc.stdout.on('data', read); proc.stderr.on('data', read);
    });
    expect(output).toContain('OWNER_READY');
  } finally {
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
    await exited; clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
