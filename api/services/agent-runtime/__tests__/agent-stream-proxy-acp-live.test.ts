import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamAgentSession } from '../agent-stream-proxy.js';
import { sessionLiveBus } from '../session-live-bus.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { nowIso } from '../runtime-ids.js';
import { mergeAcpSessionMetadata } from '../acp-engine/acp-session-metadata.js';
import { agentRuntimeStore } from '../session-store.js';

vi.mock('../acp-engine/acp-session-engine.js', () => ({
  acpSessionEngine: {
    stream: vi.fn(async function* () {
      yield {
        type: 'message_delta',
        runId: 'run-acp-live',
        stepId: 'step-acp-live',
        delta: 'streaming',
      };
    }),
    isSessionStreaming: vi.fn(() => false),
    usesAcpSession: vi.fn(() => true),
    interruptSession: vi.fn(),
    closeSession: vi.fn(),
  },
}));

describe('streamAgentSession ACP live forwarding', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('forwards ACP stream chunks to sessionLiveBus', async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      model: 'cursor-acp/default',
    });
    agentRuntimeStore.updateSession(session.id, {
      sessionMetadata: mergeAcpSessionMetadata(session, {
        providerId: 'cursor-acp',
        acpSessionId: 'acp_sess_live',
        engineModel: 'cursor-acp/default',
      }),
      updatedAt: nowIso(),
    });

    const events: Array<{ type: string; delta?: string }> = [];
    const unsubscribe = sessionLiveBus.subscribe(session.id, (event) => {
      events.push(event);
    });

    for await (const _chunk of streamAgentSession(session.id, 'turn', {
      message: 'hello',
      model: 'cursor-acp/default',
    })) {
      // drain stream
    }

    expect(events).toEqual([
      { type: 'message_delta', stepId: 'step-acp-live', delta: 'streaming' },
    ]);

    unsubscribe();
    sessionLiveBus.cleanup(session.id);
  });
});
