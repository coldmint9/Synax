import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from '../tools/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { permissionPolicy } from '../permission-policy.js';
import { permissionRulesForTier, resolveSessionPermissionRules } from '../permission-tiers.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('permissionRulesForTier', () => {
  it('boundary mode allows workspace reads/edits and reviews commands', () => {
    const rules = permissionRulesForTier('boundary');

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
    }).action).toBe('allow');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'rg foo',
      rules,
    }).action).toBe('allow');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'npm test',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'task',
      internalGate: 'none',
      rules,
    }).action).toBe('allow');
  });

  it('auto mode approves known local reads and asks for uncertain commands', () => {
    const rules = permissionRulesForTier('auto');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'ls src',
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
      { permissionTier: 'auto' },
    );

    expect(permissionPolicy.evaluate({
      sessionId: 's1',
      category: 'write',
      internalGate: 'write',
      rules,
    }).action).toBe('allow');
  });
});

// Shell policy tests still need a known directory; never inherit the API cwd implicitly.
beforeEach(() => setSessionWorkspaceRoot('s1', process.cwd()));
afterEach(() => clearSessionWorkspaceRoot('s1'));
