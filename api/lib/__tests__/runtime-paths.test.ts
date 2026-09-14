import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { runtimeAsset } from '../runtime-paths.js';
describe('source and packaged Runtime resources', () => {
  it('uses a source module URL when running through tsx', () => {
    expect(runtimeAsset(pathToFileURL('/repo/api/services/skills/paths.ts').href, '../../skills/builtin', 'skills/builtin')).toBe('/repo/api/skills/builtin');
  });
  it('resolves compiled API and nested workers independently of cwd', () => {
    const original = process.argv;
    try {
      process.argv = ['node', '/opt/synax/server.cjs'];
      expect(runtimeAsset(undefined, '../../skills/builtin', 'skills/builtin')).toBe('/opt/synax/skills/builtin');
      process.argv = ['node', '/opt/synax/workers/agent-session-runner.cjs'];
      expect(runtimeAsset(undefined, '.', 'workers/analyzer-worker.cjs')).toBe('/opt/synax/workers/analyzer-worker.cjs');
      process.argv = ['node'];
      expect(() => runtimeAsset(undefined, '.', 'migrations')).toThrow('entry path');
    } finally { process.argv = original; }
  });
});
