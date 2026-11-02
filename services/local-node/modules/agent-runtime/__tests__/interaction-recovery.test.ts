import { beforeEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ listSessionProjection: vi.fn(), controlState: vi.fn() }));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: runtime }));
import { recoverAnsweredInteractionsOnce, stopAnsweredInteractionRecovery } from '../interaction-recovery.js';

const handlers = () => ({ resume: vi.fn(), continue: vi.fn() });

beforeEach(async () => { vi.clearAllMocks(); await stopAnsweredInteractionRecovery(); });

it('shares slow scans and resumes each answered interaction once', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 's', status: 'waiting_input', activeRunId: 'r' }]);
  let release!: (state: unknown) => void;
  runtime.controlState.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const host = handlers();
  const first = recoverAnsweredInteractionsOnce(host);
  for (let tick = 0; tick < 20; tick++) expect(recoverAnsweredInteractionsOnce(host)).toBe(first);
  await Promise.resolve();
  expect(runtime.controlState).toHaveBeenCalledExactlyOnceWith('s');
  release({ interactions: [{ id: 'i', runId: 'r', kind: 'clarification', status: 'answered', response: 'ok' }] });
  await first;
  expect(host.resume).toHaveBeenCalledExactlyOnceWith('s');
  expect(host.continue).not.toHaveBeenCalled();
});

it('leaves idle sessions cold and ignores pending, consumed or unrelated answers', async () => {
  runtime.listSessionProjection.mockResolvedValue([
    { id: 'idle', status: 'completed' }, { id: 'waiting', status: 'waiting_input', activeRunId: 'r' },
  ]);
  runtime.controlState.mockResolvedValue({ interactions: [
    { id: 'p', runId: 'r', kind: 'clarification', status: 'pending', response: 'not ready' },
    { id: 'o', runId: 'old-run', kind: 'clarification', status: 'answered', response: 'old' },
    { id: 'c', runId: 'r', kind: 'clarification', status: 'answered', response: 'done', consumedAt: 'now' },
  ] });
  const host = handlers();
  await recoverAnsweredInteractionsOnce(host);
  expect(runtime.controlState).toHaveBeenCalledExactlyOnceWith('waiting');
  expect(host.resume).not.toHaveBeenCalled();
  expect(host.continue).not.toHaveBeenCalled();
});

it('continues a saved answer whose run ended with the app', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 'restarted', status: 'waiting_input', activeRunId: null }]);
  runtime.controlState.mockResolvedValue({ interactions: [
    { id: 'i', runId: 'dead', kind: 'clarification', status: 'answered', response: { action: 'submit' } },
  ] });
  const host = handlers();
  await recoverAnsweredInteractionsOnce(host);
  expect(host.resume).not.toHaveBeenCalled();
  expect(host.continue).toHaveBeenCalledExactlyOnceWith('restarted', 'i');
});

it('never replays a plan approval the restart left without a checkpoint', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 'plan', status: 'waiting_input', activeRunId: null }]);
  runtime.controlState.mockResolvedValue({ interactions: [
    { id: 'i', runId: 'dead', kind: 'plan_approval', status: 'answered', response: { action: 'execute' } },
  ] });
  const host = handlers();
  await recoverAnsweredInteractionsOnce(host);
  expect(host.continue).not.toHaveBeenCalled();
  expect(host.resume).not.toHaveBeenCalled();
});

it('bounds continuation retries and keeps scanning the rest', async () => {
  runtime.listSessionProjection.mockResolvedValue([
    { id: 'broken', status: 'waiting_input', activeRunId: null },
    { id: 'next', status: 'waiting_input', activeRunId: null },
  ]);
  runtime.controlState.mockImplementation(async (sessionId: string) => ({ interactions: [
    { id: `i-${sessionId}`, runId: 'dead', kind: 'clarification', status: 'answered', response: { action: 'submit' } },
  ] }));
  const host = handlers();
  host.continue.mockImplementation(async (sessionId: string) => {
    if (sessionId === 'broken') throw new Error('provider unavailable');
  });
  for (let pass = 0; pass < 5; pass++) await recoverAnsweredInteractionsOnce(host);
  expect(host.continue.mock.calls.filter(([sessionId]) => sessionId === 'broken')).toHaveLength(3);
  expect(host.continue.mock.calls.filter(([sessionId]) => sessionId === 'next')).toHaveLength(5);
});

it('retries on the next pass after a read failure', async () => {
  runtime.listSessionProjection.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([]);
  await expect(recoverAnsweredInteractionsOnce(handlers())).rejects.toThrow('unavailable');
  await expect(recoverAnsweredInteractionsOnce(handlers())).resolves.toBeUndefined();
});

it('drains an in-flight read without resuming a session after shutdown begins', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 's', status: 'waiting_input', activeRunId: 'r' }]);
  let release!: (state: unknown) => void;
  runtime.controlState.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const host = handlers();
  const running = recoverAnsweredInteractionsOnce(host);
  await Promise.resolve();
  const stopped = stopAnsweredInteractionRecovery();
  release({ interactions: [{ id: 'i', runId: 'r', kind: 'clarification', status: 'answered', response: 'ok' }] });
  await Promise.all([running, stopped]);
  expect(host.resume).not.toHaveBeenCalled();
  expect(host.continue).not.toHaveBeenCalled();
});
