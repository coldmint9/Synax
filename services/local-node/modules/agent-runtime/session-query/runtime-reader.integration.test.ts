import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuntimeStore } from '../session-store.js';
import { agentSessionRuntime } from '../session-runtime.js';
import {
  explorerSessionInput,
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from '../__tests__/agent-runtime-fixtures.js';
import {
  sessionListQuerySchema,
  sessionSearchQuerySchema,
  sessionStatusQuerySchema,
  createRuntimeSessionReader,
  SessionQueryService,
} from './index.js';

/**
 * The facade talks to the real Rust sidecar. Unit tests stub the reader, so this
 * one guards the wire: projection shape, transcript records and missing sessions.
 */
describe('session query runtime reader', () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
  });

  it('lists, inspects and searches authoritative sessions', async () => {
    const parent = agentSessionRuntime.create(plannerSessionInput);
    const child = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: parent.id,
    });
    agentRuntimeStore.appendMessage({
      id: `msg-${parent.id}-needle`,
      sessionId: parent.id,
      runId: null,
      stepId: null,
      role: 'user',
      content: 'Please fix the needle regression in CI',
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    await agentRuntimeStore.flush();
    const service = new SessionQueryService(
      createRuntimeSessionReader(),
      () => 'project-alpha',
    );

    const list = await service.list(
      sessionListQuerySchema.parse({}),
      parent.id,
    );
    expect(list.projectId).toBe('project-alpha');
    expect(list.items.map((item) => item.id)).toContain(parent.id);
    expect(list.items.map((item) => item.id)).not.toContain(child.id);

    const status = await service.status(
      sessionStatusQuerySchema.parse({
        sessionIds: [parent.id],
        includeChildren: true,
      }),
      parent.id,
    );
    expect(status.items[0]).toMatchObject({ id: parent.id });
    expect(status.items[0].children.map((item) => item.id)).toContain(child.id);

    const search = await service.search(
      sessionSearchQuerySchema.parse({
        query: 'needle regression',
        sessionIds: [parent.id],
      }),
      parent.id,
    );
    expect(search.items).toEqual([
      expect.objectContaining({
        sessionId: parent.id,
        kind: 'message',
        messageId: `msg-${parent.id}-needle`,
        role: 'user',
      }),
    ]);

    const missing = await service.status(
      sessionStatusQuerySchema.parse({ sessionIds: [parent.id, 'ars_missing'] }),
      parent.id,
    );
    expect(missing.missing).toEqual(['ars_missing']);
  });
});
