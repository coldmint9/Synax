import { beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { permissionRulesForTier, resolveSessionPermissionRules } from '../permission-tiers.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('permissionRulesForTier', () => {
  it('readonly asks for writes, deletes, and read shell; denies mutating shell', () => {
    const rules = permissionRulesForTier('readonly');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'read',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'write',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'rg foo',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'npm test',
      rules,
    }).action).toBe('deny');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'none',
      rules,
    }).action).toBe('allow');
  });

  it('readwrite allows read/write/delete and read shell; asks for mutating shell', () => {
    const rules = permissionRulesForTier('readwrite');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'git diff',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'npm test',
      rules,
    }).action).toBe('ask');
  });

  it('unrestricted allows all gates', () => {
    const rules = permissionRulesForTier('unrestricted');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'npm test',
      rules,
    }).action).toBe('allow');
  });
});

describe('resolveSessionPermissionRules', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('prefers permissionTier over profile defaults', () => {
    const rules = resolveSessionPermissionRules(
      [{ gate: 'write', pattern: '*', action: 'ask', reason: 'profile default' }],
      { permissionTier: 'readwrite' },
    );

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'write',
      rules,
    }).action).toBe('allow');
  });
});
