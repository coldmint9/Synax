import { beforeEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ listSessionProjection: vi.fn(), controlState: vi.fn() }));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: runtime }));
import { recoverAnsweredInteractionsOnce, stopAnsweredInteractionRecovery } from '../interaction-recovery.js';

beforeEach(() => { vi.clearAllMocks(); });

it('shares slow scans and resumes each answered interaction once', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 's', status: 'waiting_input', activeRunId: 'r' }]);
  let release!: (state: unknown) => void;
  runtime.controlState.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const resume = vi.fn();
  const first = recoverAnsweredInteractionsOnce(resume);
  for (let tick = 0; tick < 20; tick++) expect(recoverAnsweredInteractionsOnce(resume)).toBe(first);
  await Promise.resolve();
  expect(runtime.controlState).toHaveBeenCalledExactlyOnceWith('s');
  release({ interactions: [{ runId: 'r', status: 'answered', response: 'ok' }] });
  await first;
  expect(resume).toHaveBeenCalledExactlyOnceWith('s');
});

it('leaves idle sessions cold and ignores pending, consumed or unrelated answers', async () => {
  runtime.listSessionProjection.mockResolvedValue([
    { id: 'idle', status: 'completed' }, { id: 'waiting', status: 'waiting_input', activeRunId: 'r' },
  ]);
  runtime.controlState.mockResolvedValue({ interactions: [
    { runId: 'r', status: 'pending', response: 'not ready' },
    { runId: 'old-run', status: 'answered', response: 'old' },
    { runId: 'r', status: 'answered', response: 'done', consumedAt: 'now' },
  ] });
  const resume = vi.fn();
  await recoverAnsweredInteractionsOnce(resume);
  expect(runtime.controlState).toHaveBeenCalledExactlyOnceWith('waiting');
  expect(resume).not.toHaveBeenCalled();
});

it('retries on the next pass after a read failure', async () => {
  runtime.listSessionProjection.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([]);
  await expect(recoverAnsweredInteractionsOnce(vi.fn())).rejects.toThrow('unavailable');
  await expect(recoverAnsweredInteractionsOnce(vi.fn())).resolves.toBeUndefined();
});

it('drains an in-flight read without resuming a session after shutdown begins', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 's', status: 'waiting_input', activeRunId: 'r' }]);
  let release!: (state: unknown) => void;
  runtime.controlState.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const resume = vi.fn();
  const running = recoverAnsweredInteractionsOnce(resume);
  await Promise.resolve();
  const stopped = stopAnsweredInteractionRecovery();
  release({ interactions: [{ runId: 'r', status: 'answered', response: 'ok' }] });
  await Promise.all([running, stopped]);
  expect(resume).not.toHaveBeenCalled();
});
