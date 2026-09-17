import { describe, expect, it } from 'vitest';
import { parseBashInvocations } from '../tools/bash-command-policy.js';
import { permissionPolicy } from '../permission-policy.js';
import { permissionRulesForTier } from '../permission-tiers.js';

describe('parseBashInvocations', () => {
  it('classifies read-only commands and git read subcommands', () => {
    expect(parseBashInvocations('rg foo')).toEqual([
      expect.objectContaining({ command: 'rg', pattern: 'rg', risk: 'read' }),
    ]);
    expect(parseBashInvocations('git diff --stat')).toEqual([
      expect.objectContaining({ command: 'git', subcommand: 'diff', pattern: 'git:diff', risk: 'read' }),
    ]);
  });

  it('classifies mutating commands and git write subcommands', () => {
    expect(parseBashInvocations('npm test')).toEqual([
      expect.objectContaining({ command: 'npm', subcommand: 'test', pattern: 'npm:test', risk: 'write' }),
    ]);
    expect(parseBashInvocations('git push origin main')).toEqual([
      expect.objectContaining({ command: 'git', subcommand: 'push', pattern: 'git:push', risk: 'write' }),
    ]);
  });

  it('evaluates every segment in a pipeline', () => {
    const invocations = parseBashInvocations('rg foo | npm test');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.risk).toBe('read');
    expect(invocations[1]?.risk).toBe('write');
  });
});

describe('evaluateShellCommand', () => {
  it('boundary mode asks for uncertain commands and permits known reads', () => {
    const rules = permissionRulesForTier('boundary');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'npm test',
      rules,
    }).action).toBe('ask');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'rg foo',
      rules,
    }).action).toBe('allow');
  });

  it('auto review permits known reads and asks for uncertain commands', () => {
    const rules = permissionRulesForTier('auto');

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'ls .',
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

  it('matches command-specific shell rules before risk class', () => {
    const rules = [
      ...permissionRulesForTier('auto'),
      { gate: 'shell' as const, pattern: 'git:push', action: 'deny' as const, reason: 'No pushing.' },
    ];

    expect(permissionPolicy.evaluateShellCommand({
      sessionId: 's1',
      category: 'shell',
      internalGate: 'shell',
      command: 'git push origin main',
      rules,
    }).action).toBe('deny');
  });
});
