import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnOwnedProcess } from '../owned-process.js';
import { externalCommandEnvironment, stopRecordedProcess, type OwnedProcessRecord } from '../process-ownership.js';
import { getRawSqlite } from '../../../db/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
beforeEach(resetAgentRuntimeFixtures);

describe('durable owned process receipts', () => {
  it('records identity before a command starts and verifies that identity during recovery', async () => {
    const child = spawnOwnedProcess(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
    try {
      await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
      const record = getRawSqlite().prepare('SELECT * FROM agent_runtime_processes WHERE pid=?').get(child.pid) as OwnedProcessRecord;
      expect(record.state).toBe('active'); expect(record.id).toBeTruthy();
      expect(await stopRecordedProcess({ ...record, id: 'different-owner-marker' })).toBe(true);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await stopRecordedProcess(record)).toBe(true);
      await vi.waitFor(() => expect(() => process.kill(child.pid!, 0)).toThrow());
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  it('does not leak the runtime database or worker flags into project commands', () => {
    vi.stubEnv('SYNAX_RUNTIME_DATA_ROOT', '/tmp/runtime-owner'); vi.stubEnv('DATA_ROOT', '/tmp/runtime-owner');
    vi.stubEnv('SYNAX_AGENT_SESSION_CHILD', '1');
    try {
      const env = externalCommandEnvironment();
      expect(env.DATA_ROOT).toBeUndefined(); expect(env.SYNAX_AGENT_SESSION_CHILD).toBeUndefined();
      expect(externalCommandEnvironment({ DATA_ROOT: '/tmp/project-test' }).DATA_ROOT).toBe('/tmp/project-test');
    } finally { vi.unstubAllEnvs(); }
  });
});
