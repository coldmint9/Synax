import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), monitor: vi.fn(), bridge: vi.fn(), close: vi.fn(),
}));
vi.mock('@trycua/cua-driver', () => ({
  EmbeddedCuaDriverHost: class {
    start = mocks.start;
    stop = mocks.stop;
    uniffiDestroy = mocks.destroy;
    waitForExit = mocks.monitor;
  },
  requestMacOsPermissions: () => ({ accessibility: true, screenRecording: true }),
}));
vi.mock('./driver-path.js', () => ({ resolveDriverExecutable: async () => '/fake/driver' }));
vi.mock('./mcp-bridge.js', () => ({
  startCuaHelperBridge: mocks.bridge,
  generationEnvironment: (generation: string) => ({ SYNAX_CUA_GENERATION: generation }),
}));

import { main } from './main.js';
import { CUA_EXIT_CODES } from './contracts.js';

const started = { generation: 'test', mcp: { command: '/fake/driver', args: [], environment: [] } };
let stdinHandlers: Map<string, () => void>;
let signalHandlers: Map<string, () => void>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.start.mockResolvedValue(started);
  mocks.stop.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.bridge.mockResolvedValue({ close: mocks.close });
  mocks.monitor.mockReturnValue(new Promise(() => undefined));
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stdin, 'destroyed', 'get').mockReturnValue(false);
  vi.spyOn(process.stdin, 'readableEnded', 'get').mockReturnValue(false);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdinHandlers = new Map();
  signalHandlers = new Map();
  vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: () => void) => {
    stdinHandlers.set(event, listener);
    return process.stdin;
  });
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') { signalHandlers.set(event, listener); return process; }
    return originalOn(event, listener);
  }) as typeof process.on);
  vi.spyOn(process.stdin, 'readableEnded', 'get').mockReturnValue(false);
  vi.spyOn(process.stdin, 'destroyed', 'get').mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Cua helper process lifecycle', () => {
  it.each(['host', 'bridge'] as const)('releases the native host after %s startup fails', async (side) => {
    (side === 'host' ? mocks.start : mocks.bridge).mockRejectedValue(new Error('startup failed'));
    await main();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(CUA_EXIT_CODES.unavailable);
  });

  it('preserves the permission failure exit code while releasing the host', async () => {
    mocks.bridge.mockRejectedValue(new Error('permission denied'));
    await main();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(CUA_EXIT_CODES.permission);
  });

  it('releases a bridge that finishes connecting after stdin EOF', async () => {
    const pending = deferred<{ close: typeof mocks.close }>();
    mocks.bridge.mockReturnValue(pending.promise);
    const running = main();
    await vi.waitFor(() => expect(mocks.bridge).toHaveBeenCalledOnce());
    stdinHandlers.get('end')!();
    stdinHandlers.get('close')!();
    pending.resolve({ close: mocks.close });
    await running;
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.monitor).not.toHaveBeenCalled();
  });

  it('does not open a bridge after SIGTERM arrives during host startup', async () => {
    const pending = deferred<typeof started>();
    mocks.start.mockReturnValue(pending.promise);
    const running = main();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    signalHandlers.get('SIGTERM')!();
    pending.resolve(started);
    await running;
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
