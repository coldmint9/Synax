import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { allMock, replyMock, updateSessionMock, appendEventMock, tryGetSessionMock } = vi.hoisted(() => ({
  allMock: vi.fn(),
  replyMock: vi.fn(),
  updateSessionMock: vi.fn(),
  appendEventMock: vi.fn(),
  tryGetSessionMock: vi.fn(),
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
  }),
}));

import { sweepExpiredPermissions } from '../permission-timeout-sweeper.js';

describe('sweepExpiredPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryGetSessionMock.mockReturnValue({ id: 'sess-1', status: 'waiting_permission' });
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

  it('auto-rejects expired pending permissions and blocks the session', () => {
    allMock.mockReturnValue([
      {
        id: 'perm-1',
        session_id: 'sess-1',
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
    expect(updateSessionMock).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      status: 'blocked',
      blockedReason: 'Permission request timed out.',
    }));
    expect(appendEventMock).toHaveBeenCalled();
  });

  it('skips when session no longer exists', () => {
    allMock.mockReturnValue([
      {
        id: 'perm-2',
        session_id: 'sess-missing',
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
