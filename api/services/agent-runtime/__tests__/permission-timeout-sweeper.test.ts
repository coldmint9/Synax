import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const {
  allMock,
  replyMock,
  updateSessionMock,
  appendEventMock,
  tryGetSessionMock,
  getRunMock,
  updateRunMock,
  getRunStepMock,
  updateRunStepMock,
  getToolCallMock,
  updateToolCallMock,
} = vi.hoisted(() => ({
  allMock: vi.fn(),
  replyMock: vi.fn(),
  updateSessionMock: vi.fn(),
  appendEventMock: vi.fn(),
  tryGetSessionMock: vi.fn(),
  getRunMock: vi.fn(),
  updateRunMock: vi.fn(),
  getRunStepMock: vi.fn(),
  updateRunStepMock: vi.fn(),
  getToolCallMock: vi.fn(),
  updateToolCallMock: vi.fn(),
}));

vi.mock('../permission-policy.js', () => ({
  permissionPolicy: {
    reply: (...args: unknown[]) => replyMock(...args),
  },
}));

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: {
    tryGetSession: (...args: unknown[]) => tryGetSessionMock(...args),
    updateSession: (...args: unknown[]) => updateSessionMock(...args),
    getRun: (...args: unknown[]) => getRunMock(...args),
    updateRun: (...args: unknown[]) => updateRunMock(...args),
    getRunStep: (...args: unknown[]) => getRunStepMock(...args),
    updateRunStep: (...args: unknown[]) => updateRunStepMock(...args),
    getToolCall: (...args: unknown[]) => getToolCallMock(...args),
    updateToolCall: (...args: unknown[]) => updateToolCallMock(...args),
  },
}));

vi.mock('../event-service.js', () => ({
  agentEventService: {
    append: (...args: unknown[]) => appendEventMock(...args),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../db/index.js', () => ({
  getRawSqlite: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => allMock(...args),
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args),
  }),
}));

import { sweepExpiredPermissions } from '../permission-timeout-sweeper.js';

describe('sweepExpiredPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryGetSessionMock.mockReturnValue({ id: 'sess-1', status: 'waiting_permission' });
    getRunMock.mockReturnValue({ id: 'run-1', status: 'waiting_permission' });
    getRunStepMock.mockReturnValue({ id: 'step-1', status: 'waiting_permission' });
    getToolCallMock.mockReturnValue({ id: 'tool-1', status: 'pending' });
    replyMock.mockReturnValue({
      id: 'perm-1',
      action: 'deny',
      userReply: 'reject',
      reason: 'Writes require explicit approval. Permission timed out.',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-rejects expired pending permissions and completes the execution lineage', () => {
    allMock.mockReturnValue([
      {
        id: 'perm-1',
        session_id: 'sess-1',
        run_id: 'run-1',
        step_id: 'step-1',
        tool_call_id: 'tool-1',
        action: 'ask',
        user_reply: null,
        resolved_at: null,
        created_at: '2000-01-01T00:00:00.000Z',
      },
    ]);

    const swept = sweepExpiredPermissions();

    expect(allMock).toHaveBeenCalled();
    expect(swept).toBe(1);
    expect(replyMock).toHaveBeenCalledWith('sess-1', 'perm-1', 'reject', 'Permission timed out.');
    expect(updateRunStepMock).toHaveBeenCalledWith('step-1', expect.objectContaining({
      status: 'blocked',
      finishReason: 'permission_timeout',
    }));
    expect(updateToolCallMock).toHaveBeenCalledWith('sess-1', 'tool-1', expect.objectContaining({
      status: 'denied',
    }));
    expect(updateRunMock).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'blocked',
      stopReason: 'Permission request timed out.',
    }));
    expect(updateSessionMock).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      status: 'completed',
      blockedReason: 'Permission request timed out.',
      activeRunId: null,
    }));
    expect(appendEventMock).toHaveBeenCalled();
  });

  it('skips when session no longer exists', () => {
    allMock.mockReturnValue([
      {
        id: 'perm-2',
        session_id: 'sess-missing',
        run_id: null,
        step_id: null,
        tool_call_id: null,
        action: 'ask',
        user_reply: null,
        resolved_at: null,
        created_at: '2000-01-01T00:00:00.000Z',
      },
    ]);
    tryGetSessionMock.mockReturnValue(null);

    expect(sweepExpiredPermissions()).toBe(0);
    expect(replyMock).not.toHaveBeenCalled();
  });
});
