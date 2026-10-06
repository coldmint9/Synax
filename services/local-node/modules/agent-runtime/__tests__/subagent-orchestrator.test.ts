import { describe, expect, it, vi } from 'vitest';
import {
  getSubagentLiveness,
  runBatch,
  runChildToCompletion,
  type SubagentSpec,
} from '../subagent-orchestrator.js';

describe('subagent liveness', () => {
  const now = Date.parse('2026-10-05T00:00:00.000Z');

  it('distinguishes a live lease, an expired lease, waiting, and terminal sessions', () => {
    expect(getSubagentLiveness('running', {
      state: 'running',
      leaseExpiresAt: '2026-10-05T00:00:30.000Z',
    }, now)).toBe('healthy');
    expect(getSubagentLiveness('running', {
      state: 'running',
      leaseExpiresAt: '2026-10-04T23:59:30.000Z',
    }, now)).toBe('stale');
    expect(getSubagentLiveness('running', { state: 'waiting', phase: 'waiting' }, now)).toBe('waiting');
    expect(getSubagentLiveness('completed', { state: 'completed' }, now)).toBe('completed');
  });
});

/** Build injectable deps backed by an in-memory session map. */
function makeDeps(behaviors: Record<string, {
  endStatus?: string;
  runStatus?: string;
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
    updateSession: (id: string, patch: { status?: string; blockedReason?: string | null }) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      Object.assign(s, patch);
      return { id, projectId: 'p', status: s.status } as never;
    },
    listRuns: (id: string) => [{
      status: behaviors[id]?.runStatus ?? 'completed',
      stopReason: behaviors[id]?.runStatus === 'blocked' ? 'Blocked.' : null,
    }],
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
  return { loop: loop as never, sessions: sessionsRuntime as never, store: store as never, createSession: sessionsRuntime.create };
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
      'child-3': { endStatus: 'completed', runStatus: 'blocked', resultSummary: null },
    });
    const results = await runBatch('parent', [spec('a'), spec('b'), spec('c')], {}, deps);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('completed');
    // child-2 threw but ended 'running' (never completed) → failed, not a rejection.
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('blocked');
  });

  it('does not apply a total wall-clock timeout to a healthy child', async () => {
    const deps = makeDeps({
      'child-1': { durationMs: 10, endStatus: 'completed', resultSummary: 'fast' },
    });
    const results = await runBatch('parent', [spec('fast')], { maxConcurrency: 2 }, deps);
    expect(results[0].status).toBe('completed');
  });

  it('runChildToCompletion returns a terminal result without throwing', async () => {
    const deps = makeDeps({ 'child-1': { durationMs: 10, endStatus: 'completed' } });
    deps.createSession({ profileId: 'explorer' }); // create child-1
    const result = await runChildToCompletion('child-1', spec('x'), {}, deps);
    expect(result.status).toBe('completed');
  });
});
