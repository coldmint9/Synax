import { beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { explorerSessionInput, plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('sub-session safety', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('inherits parent permissions and denies child writes', () => {
    const parent = agentSessionRuntime.create(plannerSessionInput);
    const child = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: parent.id });
    const decision = permissionPolicy.evaluate({
      sessionId: child.id,
      category: 'write',
      internalGate: 'write',
      rules: child.permissionRules,
      isSubSession: true,
    });

    expect(child.parentSessionId).toBe(parent.id);
    expect(decision.action).toBe('deny');
  });
});
