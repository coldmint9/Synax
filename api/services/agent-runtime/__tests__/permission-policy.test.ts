import { beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('permissionPolicy', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('allows project-contained reads and shell by default (whitelist-restricted)', () => {
    const read = permissionPolicy.evaluate({ sessionId: 's1', category: 'read' });
    const shell = permissionPolicy.evaluate({ sessionId: 's1', category: 'shell', internalGate: 'shell' });

    expect(read.action).toBe('allow');
    expect(shell.action).toBe('allow');
  });

  it('asks for writes and denies external execution', () => {
    const write = permissionPolicy.evaluate({ sessionId: 's1', category: 'write', internalGate: 'write' });
    const external = permissionPolicy.evaluate({ sessionId: 's1', category: 'external_execution' });

    expect(write.action).toBe('ask');
    expect(external.action).toBe('deny');
  });

  it('asks for task delegation by default and respects profile rules', () => {
    const defaultDecision = permissionPolicy.evaluate({ sessionId: 's1', category: 'task', internalGate: 'task' });
    const allowedByProfile = permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'task',
      rules: [{ gate: 'task', pattern: '*', action: 'ask', reason: 'Profile allows task approval.' }],
    });

    expect(defaultDecision.action).toBe('ask');
    expect(allowedByProfile.action).toBe('ask');
  });

  it('hard-denies sub-session write attempts in v1', () => {
    const decision = permissionPolicy.evaluate({
      sessionId: 'child',
      category: 'write',
      internalGate: 'write',
      isSubSession: true,
    });

    expect(decision.action).toBe('deny');
    expect(decision.reason).toMatch(/sub-sessions cannot write/);
  });

  it('matches wildcard permission patterns using OpenCode-style semantics', () => {
    const denied = permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'task',
      pattern: 'orchestrator-fast',
      rules: [{ gate: 'task', pattern: 'orchestrator-*', action: 'deny', reason: 'Blocked agent family.' }],
    });
    const fallback = permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'task',
      pattern: 'general',
      rules: [{ gate: 'task', pattern: 'orchestrator-*', action: 'deny', reason: 'Blocked agent family.' }],
    });

    expect(denied.action).toBe('deny');
    expect(fallback.action).toBe('ask');
  });
});
