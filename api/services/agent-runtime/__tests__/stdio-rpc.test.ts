import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../managed-process.js', () => ({ spawnManagedProcess: mock.spawn }));
import { StdioRpc } from '../backends/stdio-rpc.js';
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
let end: () => void;
let writes: string[];
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  writes = []; child.stdin.on('data', data => writes.push(String(data)));
  const closed = new Promise<void>(resolve => { end = resolve; });
  mock.spawn.mockReturnValue({ child, closed, stop: vi.fn(async () => end()) });
});
describe('CLI stdio RPC transport', () => {
  it('assembles split frames and handles reverse requests without exposing stray stdout', async () => {
    const rpc = new StdioRpc('fixture', [], '/tmp');
    const notification = vi.fn(); rpc.onNotification(notification);
    const pending = rpc.request('initialize');
    child.stdout.write('not protocol\n{"id":1,"res');
    child.stdout.write('ult":{"ok":true}}\n{"method":"event","params":{"value":1}}\n');
    expect(await pending).toEqual({ ok: true }); expect(notification).toHaveBeenCalledTimes(1);
    rpc.onRequest(async (method, params) => ({ method, params }));
    child.stdout.write('{"id":"reverse","method":"approve","params":{}}\n');
    await vi.waitFor(() => expect(writes.some(line => line.includes('"id":"reverse","result"'))).toBe(true));
    await rpc.stop();
  });
  it('rejects pending requests on process exit', async () => {
    const rpc = new StdioRpc('fixture', [], '/tmp'); const pending = rpc.request('pending');
    const rejection = expect(pending).rejects.toThrow('closed'); end(); await rejection;
    await expect(rpc.request('too-late')).rejects.toThrow('closed');
  });
  it('does not swallow a mapper exception and leave the turn waiting forever', async () => {
    const rpc = new StdioRpc('fixture', [], '/tmp'); rpc.onNotification(() => { throw new Error('mapper failed'); });
    const pending = rpc.request('pending'); const rejection = expect(pending).rejects.toThrow('mapper failed');
    child.stdout.write('{"method":"broken"}\n'); await rejection; await rpc.closed;
    expect(rpc.failure?.message).toBe('mapper failed');
  });
  it('returns a protocol error for a synchronous reverse-request handler failure', async () => {
    const rpc = new StdioRpc('fixture', [], '/tmp'); rpc.onRequest(() => { throw new Error('unsupported'); });
    child.stdout.write('{"id":2,"method":"unknown"}\n');
    await vi.waitFor(() => expect(writes.some(line => line.includes('"error"'))).toBe(true));
    expect(rpc.failure).toBeUndefined(); await rpc.stop();
  });
});
