import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentSessionRuntime } from '../../services/agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../../services/agent-runtime/session-store.js';
import { executorInput, resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';

describe('session invocation usage route', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('returns normalized invocation usage', async () => {
    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.appendToolCall({
      id: 'call-1',
      sessionId: session.id,
      runId: null,
      stepId: null,
      modelToolCallId: null,
      toolId: 'file.read',
      category: 'read',
      mutability: 'read',
      argsHash: 'hash',
      inputSummary: 'README.md',
      inputRef: { path: 'README.md' },
      outputSummary: null,
      outputRef: null,
      status: 'completed',
      permissionDecisionId: null,
      startedAt: '2026-09-21T00:00:00.000Z',
      endedAt: '2026-09-21T00:00:01.000Z',
      error: null,
    });

    const response = await agentRuntimeRoutes.request(`/sessions/${session.id}/invocation-usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ kind: 'tool', id: 'file.read', callCount: 1 }],
      totalCalls: 1,
    });
  });

  it('uses normal not-found behavior', async () => {
    const response = await agentRuntimeRoutes.request('/sessions/missing/invocation-usage');
    expect(response.status).toBe(404);
  });
});
