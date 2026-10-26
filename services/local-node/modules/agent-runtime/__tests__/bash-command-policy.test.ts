import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from '../tools/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCommandDiscardsLocalChanges, gitMergeWorkflowSubcommands, parseBashInvocations } from '../tools/bash-command-policy.js';
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

  it('identifies merge workflow commands while ignoring read-only git inspection', () => {
    expect([...gitMergeWorkflowSubcommands('git status && git diff')]).toEqual([]);
    expect([...gitMergeWorkflowSubcommands('git merge feature/foo')]).toEqual(['merge']);
    expect([...gitMergeWorkflowSubcommands('git fetch origin && git rebase origin/main')]).toEqual(['rebase']);
    expect([...gitMergeWorkflowSubcommands('git -C /tmp/repo merge feature/foo')]).toEqual(['merge']);
    expect([...gitMergeWorkflowSubcommands('git cherry-pick abc && git revert def')]).toEqual(['cherry-pick', 'revert']);
  });
});

describe('gitCommandDiscardsLocalChanges', () => {
  it('allows read-only queries, dry runs and index-only resets', () => {
    for (const command of [
      'git stash list',
      'git stash show -p',
      'git --no-pager stash list',
      'git status',
      'git clean -n',
      'git clean --dry-run',
      'git reset',
      'git reset src/app.ts',
      'git stash -h',
      'rg "git stash" docs',
    ])
      expect(gitCommandDiscardsLocalChanges(command)).toBe(false);
  });

  it('flags every form that moves or discards uncommitted work', () => {
    for (const command of [
      'git stash',
      'git stash push -u -m baseline',
      'git stash pop',
      'git stash apply',
      'git stash drop',
      'git stash clear',
      'git reset --hard',
      'git reset --keep HEAD~1',
      'git clean -fd',
      'git clean --force -d',
      'git restore .',
      'git -C /tmp/repo reset --hard',
      'npm test && git stash',
    ])
      expect(gitCommandDiscardsLocalChanges(command)).toBe(true);
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

// Shell policy tests still need a known directory; never inherit the API cwd implicitly.
beforeEach(() => setSessionWorkspaceRoot('s1', process.cwd()));
afterEach(() => clearSessionWorkspaceRoot('s1'));
