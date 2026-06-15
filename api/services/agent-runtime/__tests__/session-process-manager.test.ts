import { describe, it, expect } from 'vitest';
import { sessionProcessManager } from '../session-process-manager.js';

describe('sessionProcessManager', () => {
  it('reports no active streams initially', () => {
    expect(sessionProcessManager.isSessionStreaming('sess-1')).toBe(false);
  });

  it('interruptSessions on unknown sessions is a no-op', async () => {
    sessionProcessManager.interruptSessions(['missing-session']);
    await sessionProcessManager.waitForIdleSessions(['missing-session']);
  });
});
