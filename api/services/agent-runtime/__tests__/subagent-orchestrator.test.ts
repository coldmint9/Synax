import { describe, expect, it, vi } from 'vitest';
import {
  runBatch,
  runChildToCompletion,
  type SubagentSpec,
} from '../subagent-orchestrator.js';

/** Build injectable deps backed by an in-memory session map. */
function makeDeps(behaviors: Record<string, {
  endStatus?: string;
  resultSummary?: string | null;
  /** ms the stream stays open; if it exceeds the timeout, abort wins. */
  durationMs?: number;
  /** if set, the stream rejects after durationMs. */
  throwError?: string;
}>) {
  const sessions = new Map<string, { id: string; status: string; resultSummary: string | null; blockedReason: string | null }>();
  let counter = 0;

  const store = {
    getSession: (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return { id, projectId: 'p', status: s.status } as never;
    },
    tryGetSession: (id: string) => {
      const s = sessions.get(id);
      return s ? ({ ...s } as never) : undefined;
    },
  };

  const sessionsRuntime = {
    create: (input: { profileId: string }) => {
      const id = `child-${++counter}`;
      sessions.set(id, { id, status: 'running', resultSummary: null, blockedReason: null });
      return { id, profileId: input.profileId } as never;
    },
  };

  const loop = {
    async *streamRun(childId: string, _input: unknown, signal?: AbortSignal) {
      const b = behaviors[childId] ?? { endStatus: 'completed', resultSummary: 'done' };
      const duration = b.durationMs ?? 0;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (b.throwError) { reject(new Error(b.throwError)); return; }
          const s = sessions.get(childId)!;
          s.status = b.endStatus ?? 'completed';
          s.resultSummary = b.resultSummary ?? 'done';
          resolve();
        }, duration);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          // Aborted child stays non-completed (simulates interruption).
          reject(new Error('aborted'));
        }, { once: true });
      });
      yield { type: 'done' } as never;
    },
  };

  // Seed a parent session.
  sessions.set('parent', { id: 'parent', status: 'running', resultSummary: null, blockedReason: null });
  return { loop: loop as never, sessions: sessionsRuntime as never, store: store as never };
}

const spec = (label: string): SubagentSpec => ({ profileId: 'explorer', prompt: `explore ${label}`, label });

describe('subagent-orchestrator', () => {
  it('returns ordered results, one per spec', async () => {
    const deps = makeDeps({
      'child-1': { endStatus: 'completed', resultSummary: 'A' },
      'child-2': { endStatus: 'completed', resultSummary: 'B' },
      'child-3': { endStatus: 'completed', resultSummary: 'C' },
    });
    const results = await runBatch('parent', [spec('a'), spec('b'), spec('c')], {}, deps);
    expect(results).toHaveLength(3);
    expect(results.map(r => r.spec.label)).toEqual(['a', 'b', 'c']);
    expect(results.every(r => r.status === 'completed')).toBe(true);
  });

  it('isolates a failing child — the batch still resolves with all slots', async () => {
    const deps = makeDeps({
      'child-1': { endStatus: 'completed', resultSummary: 'ok' },
      'child-2': { throwError: 'boom' },
      'child-3': { endStatus: 'blocked', resultSummary: null },
    });
    const results = await runBatch('parent', [spec('a'), spec('b'), spec('c')], {}, deps);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('completed');
    // child-2 threw but ended 'running' (never completed) → failed, not a rejection.
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('blocked');
  });

  it('times out a hung child and aborts only it', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      'child-1': { durationMs: 10, endStatus: 'completed', resultSummary: 'fast' },
      'child-2': { durationMs: 10_000_000, endStatus: 'completed' }, // hangs forever
    });
    const promise = runBatch('parent', [spec('fast'), spec('hung')], { perChildTimeoutMs: 1000, maxConcurrency: 2 }, deps);
    await vi.advanceTimersByTimeAsync(2000);
    const results = await promise;
    vi.useRealTimers();
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('timeout');
  });

  it('runChildToCompletion never throws on a hung child', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({ 'child-1': { durationMs: 10_000_000 } });
    deps.sessions.create({ profileId: 'explorer' }); // create child-1
    const promise = runChildToCompletion('child-1', spec('x'), { timeoutMs: 500 }, deps);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.status).toBe('timeout');
  });
});
