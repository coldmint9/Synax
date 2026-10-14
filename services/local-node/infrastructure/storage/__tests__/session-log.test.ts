import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionLog } from '../session-log.js';

let root: string;
const logs: SessionLog[] = [];
function logAt(root: string, options?: { replayRetention?: number; compactBytes?: number }) { const log = new SessionLog(root, options); logs.push(log); return log; }
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-session-log-')); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(logs.splice(0).map(log => log.close())); await fs.rm(root, { recursive: true, force: true }); });
const event = (n: number) => ({ type: 'message', payload: { n } });

describe('session log commit protocol', () => {
  it('serializes a session while committing independent sessions concurrently', async () => {
    const log = logAt(root);
    await Promise.all(Array.from({ length: 32 }, async (_, session) => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, n) => log.append(`s${session}`, `r${n}`, [event(n)])));
      expect(results.map(result => result.lastSeq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect((await log.read(`s${session}`)).map(row => row.payload)).toEqual(Array.from({ length: 12 }, (_, n) => ({ n })));
    }));
    const reopened = logAt(root);
    expect(await reopened.cursor('s31')).toBe(12);
  });
  it('recovers acknowledged batches and returns the same receipt after an ACK is lost', async () => {
    const first = logAt(root);
    const receipt = await first.append('a', 'request', [event(1), event(2)]);
    const second = logAt(root);
    expect(await second.append('a', 'request', [event(1), event(2)])).toEqual(receipt);
    await expect(second.append('a', 'request', [event(3)])).rejects.toMatchObject({ code: 'LOG_REQUEST_CONFLICT' });
    expect(await second.cursor('a')).toBe(2);
  });
  it('repairs only an incomplete active tail and preserves earlier commits', async () => {
    await logAt(root).append('a', 'one', [event(1)]);
    await fs.appendFile(path.join(root, 'a', 'events-00000001.jsonl'), '{"format":1');
    const log = logAt(root);
    await log.append('a', 'two', [event(2)]);
    expect((await log.read('a')).map(row => row.sequence)).toEqual([1, 2]);
  });
  it('rejects corruption in a completed record instead of truncating committed history', async () => {
    await logAt(root).append('a', 'one', [event(1)]);
    const filename = path.join(root, 'a', 'events-00000001.jsonl');
    await fs.writeFile(filename, (await fs.readFile(filename, 'utf8')).replace('"n":1', '"n":9'));
    await expect(logAt(root).cursor('a')).rejects.toMatchObject({ code: 'LOG_CORRUPT' });
  });
  it('does not ACK a failed fsync, and fences further writes until recovery', async () => {
    const original = fs.open.bind(fs);
    const mock = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith('.jsonl')) handle.sync = async () => { throw new Error('injected fsync failure'); };
      return handle;
    });
    const log = logAt(root);
    await expect(log.append('a', 'one', [event(1)])).rejects.toThrow('fsync failure');
    await expect(log.append('a', 'two', [event(2)])).rejects.toMatchObject({ code: 'LOG_RECOVERY_REQUIRED' });
    mock.mockRestore();
    const recovered = logAt(root);
    expect(await recovered.status('a', 'one')).toMatchObject({ lastSeq: 1 });
    expect((await recovered.append('a', 'one', [event(1)])).lastSeq).toBe(1);
  });
  it('rotates segments without resetting sequence and supports bounded sparse reads', async () => {
    const log = logAt(root);
    for (let n = 0; n < 11; n++) await log.append('a', `r${n}`, [{ type: 'large', payload: 'x'.repeat(900_000) }]);
    expect((await fs.readdir(path.join(root, 'a'))).length).toBe(2);
    const restored = logAt(root);
    expect((await restored.read('a', 10, 1))[0].sequence).toBe(11);
    expect(await restored.cursor('a')).toBe(11);
  });
  it('compacts replay without resetting cursors or repeating retired producer requests', async () => {
    const options = { replayRetention: 2, compactBytes: 8 * 1024 };
    const producer = '11111111-1111-1111-1111-111111111111';
    const log = logAt(root, options);
    for (let n = 1; n <= 8; n++) await log.append('a', `replay:${producer}:${n}`, [{ type: 'runtime.replay', payload: 'x'.repeat(2048) }]);
    await log.close();
    const restored = logAt(root, options);
    expect(await restored.cursor('a')).toBe(8);
    const records = await restored.read('a');
    expect(records.at(-1)?.sequence).toBe(8);
    expect(records[0].sequence).toBeGreaterThan(1);
    await expect(restored.append('a', `replay:${producer}:1`, [{ type: 'runtime.replay', payload: 'old' }])).rejects.toMatchObject({ code: 'LOG_REQUEST_RETIRED' });
    expect((await restored.append('a', `replay:${producer}:9`, [{ type: 'runtime.replay', payload: 9 }])).lastSeq).toBe(9);
  });

  it.each(['before-manifest', 'after-manifest'])('recovers interrupted replay compaction at %s', async stage => {
    const options = { replayRetention: 2, compactBytes: 8 * 1024 };
    const producer = '22222222-2222-2222-2222-222222222222';
    const log = logAt(root, options);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if ((stage === 'before-manifest' && String(target).endsWith('replay-manifest.json')) ||
          (stage === 'after-manifest' && String(source).endsWith('.compact'))) throw new Error('injected publication failure');
      await rename(source, target);
    });
    for (let n = 1; n <= 4; n++) await log.append('a', `replay:${producer}:${n}`, [{ type: 'runtime.replay', payload: 'x'.repeat(2048) }]);
    failure.mockRestore();
    await log.close();
    const recovered = logAt(root, options);
    expect(await recovered.cursor('a')).toBe(4);
    expect((await recovered.read('a')).at(-1)?.sequence).toBe(4);
    expect((await recovered.append('a', `replay:${producer}:5`, [{ type: 'runtime.replay', payload: 5 }])).lastSeq).toBe(5);
  });

  it('rejects traversal and symlink session directories', async () => {
    const log = logAt(root);
    await expect(log.append('../escape', 'x', [event(1)])).rejects.toMatchObject({ code: 'LOG_SESSION_INVALID' });
    await fs.symlink(root, path.join(root, 'redirect'));
    await expect(log.append('redirect', 'x', [event(1)])).rejects.toMatchObject({ code: 'LOG_DIRECTORY_INVALID' });
  });
});
