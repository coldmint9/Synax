import { beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('permissionPolicy', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('asks for shell commands by default', () => {
    const read = permissionPolicy.evaluate({ sessionId: 's1', category: 'read' });
    const shell = permissionPolicy.evaluate({ sessionId: 's1', category: 'shell', internalGate: 'shell', pattern: 'rg' });

    expect(read.action).toBe('allow');
    expect(shell.action).toBe('ask');
  });

  it('asks for writes and denies external execution', () => {
    const write = permissionPolicy.evaluate({ sessionId: 's1', category: 'write', internalGate: 'write' });
    const external = permissionPolicy.evaluate({ sessionId: 's1', category: 'external_execution' });

    expect(write.action).toBe('ask');
    expect(external.action).toBe('deny');
  });

  it('allows session task tools without approval', () => {
    const create = permissionPolicy.evaluate({ sessionId: 's1', category: 'task', internalGate: 'none' });
    const update = permissionPolicy.evaluate({ sessionId: 's1', category: 'task', internalGate: 'none', metadata: { toolId: 'task.update' } });

    expect(create.action).toBe('allow');
    expect(update.action).toBe('allow');
  });

  it('allows subagent delegation by default and respects profile deny rules', () => {
    const defaultDecision = permissionPolicy.evaluate({ sessionId: 's1', category: 'task', internalGate: 'task' });
    const deniedByProfile = permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'task',
      rules: [{ gate: 'task', pattern: '*', action: 'deny', reason: 'Profile blocks delegation.' }],
    });

    expect(defaultDecision.action).toBe('allow');
    expect(deniedByProfile.action).toBe('deny');
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
    expect(fallback.action).toBe('allow');
  });
});
