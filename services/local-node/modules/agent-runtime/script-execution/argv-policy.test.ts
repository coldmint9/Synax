import { describe, expect, it } from 'vitest';
import { classifyArgv } from './argv-policy.js';

describe('classifyArgv', () => {
  it.each([
    ['cat', 'a file'], ['echo', '$(rm -rf .); git push | sh'],
    ['rg', '--files', '.'], ['grep', '-n', 'value', 'file'],
    ['find', '.', '-name', '*.ts', '-print'],
    ['git', 'diff'], ['git', 'diff', '--stat'], ['git', 'status', '--short'],
    ['git', '--no-pager', '-C', 'a directory', 'diff', '--', 'file'],
  ].map(argv => ({ argv })))('recognizes read tokens: $argv', ({ argv }) => {
    expect(classifyArgv(argv).risk).toBe('read');
  });

  it.each([
    [], ['unknown'], ['./cat', 'file'], ['/tmp/cat', 'file'],
    ['git', 'branch', 'new'], ['git', 'branch', '-D', 'old'],
    ['git', 'branch'], ['git', 'tag', 'v1'], ['git', 'tag', '-d', 'v1'],
    ['git', 'push'], ['git', 'custom-alias'],
    ['git', '-c', 'alias.x=!touch file', 'x'],
    ['git', '-c', 'core.pager=touch file', 'diff'],
    ['git', '--exec-path=/tmp', 'diff'],
    ['git', '--config-env=core.pager=PAGER', 'diff'],
    ['git', 'diff', '--output=result'], ['git', 'diff', '--output', 'result'],
    ['git', 'diff', '--ext-diff'], ['git', 'diff', '--textconv'],
    ['git', 'diff', '--unknown-option'],
    ['find', '.', '-exec', 'touch', 'file', ';'],
    ['find', '.', '-execdir', 'sh', '{}', ';'], ['find', '.', '-delete'],
    ['find', '.', '-fprint', 'result'], ['find', '.', '-ok', 'sh', '{}', ';'],
    ['awk', 'BEGIN {system("touch file")}'], ['awk', '{print $1}'],
    ['rg', '--pre', 'sh', 'pattern'], ['rg', '--pre=sh', 'pattern'],
    ['rg', '--hostname-bin=/tmp/program', 'pattern'],
    ['env', 'cat', 'file'], ['env', 'X=1', 'git', 'diff'],
    ['sort', '-o', 'result', 'file'], ['uniq', 'file', 'result'],
    ['date', '--set=2026-01-01'], ['node', '-e', 'console.log(1)'],
    ['cat', 'bad\0path'],
  ].map(argv => ({ argv })))('fails closed: $argv', ({ argv }) => {
    expect(classifyArgv(argv).risk).toBe('write');
  });

  it('preserves literal metacharacters and never discovers extra invocations', () => {
    expect(classifyArgv(['echo', ';', 'git push', '&&', '$(touch x)', '\nrm -rf x'])).toEqual({
      command: 'echo', subcommand: null, pattern: 'echo', risk: 'read',
    });
    expect(classifyArgv(['git diff'])).toEqual({
      command: 'git diff', subcommand: null, pattern: 'git diff', risk: 'write',
    });
  });
});
