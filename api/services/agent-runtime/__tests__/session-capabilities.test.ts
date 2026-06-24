import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentSessionRuntime } from '../session-runtime.js';
import { toolRegistry } from '../tool-registry.js';
import { wikiAgentToolProvider } from '../../wiki/wiki-agent-tool-provider.js';
import { resolveSessionCapabilities } from '../session-capabilities.js';
import { clearSessionFileReads, recordSessionFileRead } from '../read-tracker.js';
import { fileWriteTool } from '../tools/file-write.js';
import { setSessionWorkspaceRoot } from '../tools/workspace.js';
import { explorerSessionInput, executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('resolveSessionCapabilities', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    toolRegistry.registerProvider(wikiAgentToolProvider);
  });

  it('returns profile-scoped tools and active skills for explorer sessions', () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const caps = resolveSessionCapabilities(session.id);

    expect(caps.profile.id).toBe('explorer');
    expect(caps.tools.available.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([
        'bash',
        'file.glob',
        'grep.search',
        'skill.load',
        'wiki.search_content',
        'wiki.search_batch',
        'wiki.read_section',
      ]),
    );
    expect(caps.tools.available.some((tool) => tool.id === 'file.write')).toBe(false);
    expect(caps.tools.visible).toEqual(caps.tools.available);
    expect(caps.skills.active.map((skill) => skill.id)).toEqual(['code-explorer']);
    expect(caps.skills.candidates.map((skill) => skill.id)).toEqual(['code-explorer']);
  });

  it('exposes write tools for executor from the start', () => {
    const session = agentSessionRuntime.create(executorInput);
    const caps = resolveSessionCapabilities(session.id);

    expect(caps.tools.visible.some((tool) => tool.id === 'file.write')).toBe(true);
    expect(caps.tools.visible.some((tool) => tool.id === 'file.patch')).toBe(true);
    expect(caps.tools.visible.some((tool) => tool.id === 'task.create')).toBe(true);
  });
});

describe('read-before-write', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('blocks file.write on unread existing files', () => {
    const session = agentSessionRuntime.create(executorInput);
    clearSessionFileReads(session.id);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-write-guard-'));
    const relPath = 'write-guard-test.txt';
    fs.writeFileSync(path.join(tmpDir, relPath), 'original', 'utf8');
    setSessionWorkspaceRoot(session.id, tmpDir);

    try {
      expect(() =>
        fileWriteTool.execute({
          sessionId: session.id,
          args: { path: relPath, content: 'updated' },
          permission: null,
        }),
      ).toThrow(/not read in this session/i);

      recordSessionFileRead(session.id, relPath);
      const result = fileWriteTool.execute({
        sessionId: session.id,
        args: { path: relPath, content: 'updated' },
        permission: null,
      });
      expect(result.displaySummary).toContain('Wrote');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
