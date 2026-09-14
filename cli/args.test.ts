import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('synax CLI argument contract', () => {
  it('keeps the command separate from global connection options', () => {
    expect(parseArgs(['exec', '--project', 'p1', '--jsonl', 'read', 'README'])).toMatchObject({
      command: 'exec', positionals: ['read', 'README'], project: 'p1', output: 'jsonl',
    });
  });

  it('supports machine-safe resume and observation cursors', () => {
    expect(parseArgs(['watch', 'run-1', '--session', 'session-1', '--after', '42', '--json'])).toMatchObject({
      command: 'watch', positionals: ['run-1'], session: 'session-1', after: 42, output: 'json',
    });
  });

  it('rejects conflicting output modes and invalid controls', () => {
    expect(() => parseArgs(['exec', '--json', '--jsonl', 'hello'])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(['approve', 'p1', '--reply', 'maybe'])).toThrow(/permission reply/i);
  });
});
