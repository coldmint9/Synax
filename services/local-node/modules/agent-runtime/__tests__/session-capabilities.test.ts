import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentSessionRuntime } from '../session-runtime.js';
import { resolveSessionCapabilities } from '../session-capabilities.js';
import { clearSessionFileReads, recordSessionFileRead } from '../read-tracker.js';
import { fileWriteTool } from '../tools/file-write.js';
import { setSessionWorkspaceRoot } from '../tools/workspace.js';
import { explorerSessionInput, executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('resolveSessionCapabilities', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('returns profile-scoped tools and active skills for explorer sessions', () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const caps = resolveSessionCapabilities(session.id);

    expect(caps.profile.id).toBe('explorer');
    expect(caps.tools.available.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([
        'bash',
        'rg',
        'rg',
        'skill.load',
      ]),
    );
    expect(caps.tools.available.some((tool) => tool.id === 'file.write')).toBe(false);
    expect(caps.tools.visible).toEqual(caps.tools.available);
    expect(caps.skills.active).toEqual([]);
    expect(caps.skills.candidates.map((skill) => skill.id)).toEqual(['synax-builtin/synax-explore']);
  });

  it('exposes write tools for executor from the start', () => {
    const session = agentSessionRuntime.create(executorInput);
    const caps = resolveSessionCapabilities(session.id);

    expect(caps.tools.visible.some((tool) => tool.id === 'file.write')).toBe(true);
    expect(caps.tools.visible.some((tool) => tool.id === 'edit')).toBe(true);
    expect(caps.tools.visible.some((tool) => tool.id === 'task.create')).toBe(true);
  });
});

describe('read-before-write', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('auto-reads an unread existing file instead of blocking file.write', async () => {
    const session = agentSessionRuntime.create(executorInput);
    clearSessionFileReads(session.id);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-write-guard-'));
    const relPath = 'write-guard-test.txt';
    const filePath = path.join(tmpDir, relPath);
    fs.writeFileSync(filePath, 'original', 'utf8');
    setSessionWorkspaceRoot(session.id, tmpDir);

    try {
      const executeWrite = () => fileWriteTool.execute({
        sessionId: session.id, runId: null, stepId: null, toolCallId: 'write-guard',
        toolId: 'file.write', category: 'write', mutability: 'write',
        args: { path: relPath, content: 'updated' },
      });
      const first = await executeWrite();
      expect(first.displaySummary).toContain('Wrote');
      expect(first.result).toMatchObject({ implicitRead: true });
      expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');

      // Once the session holds a read record, the write stops flagging itself.
      recordSessionFileRead(session.id, relPath);
      const second = await executeWrite();
      expect(second.result).not.toMatchObject({ implicitRead: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
