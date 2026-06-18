import { beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { permissionRulesForTier, resolveSessionPermissionRules } from '../permission-tiers.js';
import { bashPermissionPattern } from '../tools/bash.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('permissionRulesForTier', () => {
  it('readonly asks for writes, deletes, and whitelisted shell commands', () => {
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

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'delete',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      pattern: 'whitelist',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      pattern: 'non-whitelist',
      rules,
    }).action).toBe('deny');
  });

  it('readwrite allows read/write/delete and whitelisted shell commands', () => {
    const rules = permissionRulesForTier('readwrite');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'write',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'delete',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      pattern: 'whitelist',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      pattern: 'non-whitelist',
      rules,
    }).action).toBe('ask');
  });

  it('unrestricted allows all gates', () => {
    const rules = permissionRulesForTier('unrestricted');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      pattern: 'non-whitelist',
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

describe('bashPermissionPattern', () => {
  it('classifies whitelisted and non-whitelisted commands', () => {
    expect(bashPermissionPattern('rg foo')).toBe('whitelist');
    expect(bashPermissionPattern('npm test')).toBe('non-whitelist');
  });
});
