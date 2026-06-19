import { beforeEach, describe, expect, it } from 'vitest';
import { inputQueueService } from '../input-queue-service.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('inputQueueService', () => {
  let sessionId: string;

  beforeEach(() => {
    resetAgentRuntimeFixtures();
    sessionId = agentSessionRuntime.create(executorInput).id;
  });

  it('enqueues, lists, removes, and drains items in FIFO order', () => {
    const first = inputQueueService.enqueue(sessionId, { message: 'First message' });
    const second = inputQueueService.enqueue(sessionId, { message: 'Second message' });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(inputQueueService.list(sessionId).map((item) => item.message)).toEqual([
      'First message',
      'Second message',
    ]);

    const drained = inputQueueService.drainNext(sessionId);
    expect(drained?.message).toBe('First message');
    expect(inputQueueService.list(sessionId)).toHaveLength(1);

    const removed = inputQueueService.remove(sessionId, second[1].id);
    expect(removed).toHaveLength(0);
  });

  it('consumes a force-marked item before FIFO head', () => {
    const items = inputQueueService.enqueue(sessionId, { message: 'First' });
    inputQueueService.enqueue(sessionId, { message: 'Second' });
    inputQueueService.markForceInject(sessionId, items[0].id);

    const consumed = inputQueueService.consumeNext(sessionId);
    expect(consumed?.message).toBe('First');
    expect(inputQueueService.getForceInjectId(sessionId)).toBeNull();
    expect(inputQueueService.list(sessionId)).toHaveLength(1);
    expect(inputQueueService.list(sessionId)[0]?.message).toBe('Second');
  });
});
