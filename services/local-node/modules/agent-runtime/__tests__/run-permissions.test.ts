import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRule } from '../contracts.js';
import {
  isProjectToolGrantDenied, permissionPolicy, resolvePermissionDecision,
  type PermissionRequestInput,
} from '../permission-policy.js';
import { permissionRulesForTier } from '../permission-tiers.js';
import { PATH_EXTRACTORS } from '../sandbox/path-extractors.js';
import { defaultSandboxConfig, SandboxAuditLog, SandboxPolicy } from '../sandbox/index.js';
import { setSessionWorkspaceRoot } from '../tools/workspace.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

const readOnlyRules: PermissionRule[] = [
  { gate: 'shell', pattern: 'read', action: 'allow' },
  { gate: 'shell', pattern: 'write', action: 'deny' },
];
function input(argv: string[], rules: PermissionRule[] = []): PermissionRequestInput & { argv: string[] } {
  return { sessionId: 'run-permissions', category: 'shell', internalGate: 'shell', argv, rules,
    metadata: { toolId: 'run', args: { argv } } };
}

describe('run permissions', () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
    setSessionWorkspaceRoot('run-permissions', process.cwd());
  });

  it('asks by default and records tokens rather than shell command text', () => {
    const argv = ['echo', 'one; git push', '$(touch file)'];
    const decision = permissionPolicy.evaluateArgvCommand(input(argv));
    expect(decision.action).toBe('ask');
    expect(decision.patterns).toEqual(['echo']);
    expect(decision.internalGate).toBe('shell');
    expect(decision.metadata?.argv).toEqual(argv);
    expect(decision.metadata?.command).toBeUndefined();
    expect(decision.metadata?.invocations).toEqual([
      { command: 'echo', subcommand: null, pattern: 'echo', risk: 'read' },
    ]);
  });

  it('allows diff but denies push and unknown executables under read/write rules', () => {
    expect(permissionPolicy.resolveArgvCommand(input(['git', 'diff'], readOnlyRules)).action).toBe('allow');
    expect(permissionPolicy.resolveArgvCommand(input(['git', 'push'], readOnlyRules)).action).toBe('deny');
    expect(permissionPolicy.resolveArgvCommand(input(['unknown'], readOnlyRules)).action).toBe('deny');
  });

  it('honors a command pattern denial without denying other git subcommands', () => {
    const rules: PermissionRule[] = [
      { gate: 'shell', pattern: 'read', action: 'allow' },
      { gate: 'shell', pattern: 'git:push', action: 'deny' },
    ];
    expect(permissionPolicy.resolveArgvCommand(input(['git', 'push'], rules)).action).toBe('deny');
    expect(permissionPolicy.resolveArgvCommand(input(['git', 'diff'], rules)).action).toBe('allow');
  });

  it('literal metacharacters never become additional denied commands', () => {
    const rules: PermissionRule[] = [...readOnlyRules, { gate: 'shell', pattern: 'git:push', action: 'deny' }];
    const resolved = permissionPolicy.resolveArgvCommand(input(['echo', 'hello; git push', '&&', 'rm x'], rules));
    expect(resolved.action).toBe('allow');
    expect(resolved.invocations).toHaveLength(1);
    expect(resolved.invocations[0].pattern).toBe('echo');
  });

  it('risk and pattern denials cannot be bypassed by broad allows or project grants', () => {
    const rules: PermissionRule[] = [...readOnlyRules, { gate: '*', pattern: '*', action: 'allow' }];
    const push = input(['git', 'push'], rules);
    expect(isProjectToolGrantDenied(push)).toBe(true);
    expect(permissionPolicy.resolveArgvCommand(push).action).toBe('deny');
    expect(isProjectToolGrantDenied(input(['git', 'diff'], rules))).toBe(false);
    expect(isProjectToolGrantDenied(input(['git', 'diff'], [
      { gate: 'shell', pattern: 'git:diff', action: 'deny' },
    ]))).toBe(true);
  });

  it.each(['auto', 'boundary'] as const)('keeps argv and all script languages manual in %s mode', mode => {
    const rules = permissionRulesForTier(mode);
    expect(permissionPolicy.resolveArgvCommand(input(['echo', 'hello'], rules)).action).toBe('ask');
    for (const language of ['sh', 'python', 'node']) {
      const script: PermissionRequestInput = {
        sessionId: 'run-permissions', category: 'shell', internalGate: 'shell', pattern: `run:${language}`, rules,
        metadata: { toolId: 'run', args: { language, source: 'echo harmless', workdir: '.' } },
      };
      expect(resolvePermissionDecision(script).action).toBe('ask');
      expect(resolvePermissionDecision({ ...script, rules: readOnlyRules }).action).toBe('deny');
      expect(isProjectToolGrantDenied({ ...script, rules: readOnlyRules })).toBe(true);
    }
  });

  it('does not map a legacy python.run deny to run', () => {
    const script: PermissionRequestInput = {
      sessionId: 'run-permissions', category: 'shell', internalGate: 'shell', pattern: 'run:python',
      rules: [{ gate: 'shell', pattern: 'python.run', action: 'deny' }],
      metadata: { toolId: 'run', args: { language: 'python', source: 'print(1)' } },
    };
    expect(isProjectToolGrantDenied(script)).toBe(false);
    expect(resolvePermissionDecision(script).action).toBe('ask');
  });
});

describe('run sandbox paths', () => {
  it('checks cwd and extensionless argv operands relative to workdir', () => {
    expect(PATH_EXTRACTORS.run({ workdir: 'nested', argv: ['cat', 'README', '../file', '/outside/file'] }))
      .toEqual(['nested', path.join('nested', 'README'), 'file', '/outside/file']);
  });

  it('checks executable paths and output option paths without shell splitting', () => {
    expect(PATH_EXTRACTORS.run({ workdir: 'nested', argv: ['./tool', '--output=../out', 'a; b'] }))
      .toEqual(['nested', path.join('nested', 'tool'), 'out', path.join('nested', 'a; b')]);
  });

  it('composes git -C directories before subsequent relative operands', () => {
    const paths = PATH_EXTRACTORS.run({ workdir: 'root', argv: ['git', '-C', 'one', '-C', 'two', 'diff', '--', 'file'] });
    expect(paths).toContain(path.join('root', 'one', 'two', 'file'));
  });

  it('preserves option-shaped operands after --, including a second --', () => {
    const operands = ['-secret', '--output=secret', '-ofile', '--'];
    expect(PATH_EXTRACTORS.run({ workdir: 'nested', argv: ['cat', '--', ...operands] }))
      .toEqual(['nested', ...operands.map(operand => path.join('nested', operand))]);
  });

  it('does not interpret literal -C operands after the git path separator', () => {
    const operands = ['-Celsewhere', '-C', 'file', '--output=secret'];
    expect(PATH_EXTRACTORS.run({ workdir: 'root', argv: ['git', '-C', 'repo', 'diff', '--', ...operands] }))
      .toEqual(['root', path.join('root', 'repo'), path.join('root', 'repo', 'diff'),
        ...operands.map(operand => path.join('root', 'repo', operand))]);
  });

  it('keeps -- as the directory argument of git -C before parsing a separator', () => {
    expect(PATH_EXTRACTORS.run({ argv: ['git', '-C', '--', 'diff', '--', '-file'] }))
      .toEqual(['.', '--', path.join('--', 'diff'), path.join('--', '-file')]);
  });

  it.each(['-secret', '--output=secret', '-Csecret', '--'])(
    'rejects a symlink escape through literal operand %s after --', (operand) => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synax-run-paths-')));
      const root = path.join(directory, 'workspace');
      const outside = path.join(directory, 'outside');
      const audit = new SandboxAuditLog();
      const policy = new SandboxPolicy(audit, defaultSandboxConfig);
      try {
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, operand), process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => policy.validateToolArgs('run', { argv: ['cat', '--', operand] }, root, 'run-paths'))
          .toThrow(/workspace boundary/);
        expect(audit.recent('run-paths')).toContainEqual(expect.objectContaining({
          kind: 'symlink_escape', requestedPath: operand, resolvedPath: outside, toolId: 'run',
        }));
        // Nonexistent children still resolve their symlinked parent directory.
        expect(() => policy.validateToolArgs('run', { argv: ['cat', '--', `${operand}/missing`] }, root, 'run-paths'))
          .toThrow(/workspace boundary/);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('never treats script source, stdin or script arguments as paths', () => {
    expect(PATH_EXTRACTORS.run({ language: 'sh', source: ['cat /private/file', 'echo ../secret'],
      scriptId: 'script-id', stdin: '/secret', args: ['/private/arg'], workdir: 'nested' })).toEqual(['nested']);
    expect(PATH_EXTRACTORS.run({ language: 'python', source: 'print("/tmp/file")' })).toEqual(['.']);
  });
});
