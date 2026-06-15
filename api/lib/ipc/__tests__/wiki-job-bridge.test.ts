import { describe, expect, it, vi } from 'vitest';
import { runtimeBus } from '../../../services/agent-runtime/runtime-bus.js';
import { sessionLiveBus } from '../../../services/agent-runtime/session-live-bus.js';
import { handleWikiJobChildMessage, resetScanProgressThrottleForTests } from '../wiki-job-bridge.js';

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/notifications/notify.js', () => ({
  notify: notifyMock,
}));

describe('wiki-job-bridge runtime events', () => {
  it('forwards runtime:event messages to runtimeBus', () => {
    const events: Array<{ type: string; sessionId: string }> = [];
    const unsubscribe = runtimeBus.subscribe((event) => {
      events.push(event);
    });

    handleWikiJobChildMessage({
      type: 'runtime:event',
      event: { type: 'session_created', sessionId: 'sess-planner' },
    });

    expect(events).toEqual([{ type: 'session_created', sessionId: 'sess-planner' }]);
    unsubscribe();
  });

  it('forwards scan:progress to task notifications', () => {
    resetScanProgressThrottleForTests();
    notifyMock.mockClear();
    handleWikiJobChildMessage({
      type: 'scan:progress',
      projectId: 'proj-1',
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      pct: 20,
      completed: 40,
      total: 200,
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_progress',
      projectId: 'proj-1',
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      meta: expect.objectContaining({ pct: 20, completed: 40, total: 200 }),
    }));
  });

  it('throttles scan:progress task notifications', () => {
    resetScanProgressThrottleForTests();
    notifyMock.mockClear();
    handleWikiJobChildMessage({
      type: 'scan:progress',
      projectId: 'proj-1',
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      pct: 20,
    });
    handleWikiJobChildMessage({
      type: 'scan:progress',
      projectId: 'proj-1',
      message: '███░░░░░░░ 25% — parsed 50/200 files',
      pct: 25,
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('forwards session:live messages to sessionLiveBus', () => {
    const sessionId = 'sess-wiki-live';
    const events: Array<{ type: string; delta?: string }> = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      events.push(event);
    });

    handleWikiJobChildMessage({
      type: 'session:live',
      sessionId,
      event: { type: 'message_delta', stepId: 'step-1', delta: 'hello' },
    });

    expect(events).toEqual([{ type: 'message_delta', stepId: 'step-1', delta: 'hello' }]);
    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });
});
