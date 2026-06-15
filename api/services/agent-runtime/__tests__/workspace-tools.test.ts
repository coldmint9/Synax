import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileReadTool } from '../tools/file-read.js';
import {
  clearSessionWorkspaceRoot,
  resolveWorkspaceRoot,
  setSessionWorkspaceRoot,
} from '../tools/workspace.js';

const sessionIds: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const sessionId of sessionIds.splice(0)) {
    clearSessionWorkspaceRoot(sessionId);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session workspace roots', () => {
  it('allows tools to operate relative to a project directory outside process.cwd()', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-project-root-'));
    tempDirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'entry.ts'), 'export const value = 42;\n', 'utf8');

    const sessionId = 'ars_workspace_test';
    sessionIds.push(sessionId);
    expect(resolveWorkspaceRoot(projectDir)).toBe(projectDir);
    setSessionWorkspaceRoot(sessionId, projectDir);

    const result = fileReadTool.execute({
      sessionId,
      runId: null,
      stepId: null,
      toolCallId: 'tool_workspace_test',
      toolId: 'file.read',
      category: 'read',
      mutability: 'read',
      args: { path: 'entry.ts' },
    });

    expect(result.result).toMatchObject({
      path: 'entry.ts',
      content: 'export const value = 42;\n',
      truncated: false,
    });
  });

  describe('project work dir resolution', () => {
    const originalDataRoot = process.env.DATA_ROOT;
    let tempDataRoot = '';

    beforeEach(() => {
      tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-workdir-registry-'));
      tempDirs.push(tempDataRoot);
      process.env.DATA_ROOT = tempDataRoot;
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
      if (originalDataRoot === undefined) delete process.env.DATA_ROOT;
      else process.env.DATA_ROOT = originalDataRoot;
    });

    it('resolveProjectWorkDir reads projects.json items wrapper', async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-project-registry-'));
      tempDirs.push(projectDir);
      const projectId = 'proj-test-opencode';
      fs.writeFileSync(path.join(tempDataRoot, 'projects.json'), JSON.stringify({
        items: [{
          id: projectId,
          source: { localPath: projectDir },
        }],
      }), 'utf8');

      const { resolveProjectWorkDir } = await import('../tools/workspace.js');
      expect(resolveProjectWorkDir(projectId)).toBe(projectDir);
    });

    it('resolveSessionWorkDir prefers an explicit session workspace root', async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-session-workdir-'));
      const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-session-override-'));
      tempDirs.push(projectDir, overrideDir);

      const projectId = 'proj-test-session-workdir';
      fs.writeFileSync(path.join(tempDataRoot, 'projects.json'), JSON.stringify({
        items: [{
          id: projectId,
          source: { localPath: projectDir },
        }],
      }), 'utf8');

      const {
        clearSessionWorkspaceRoot: clearSessionRoot,
        resolveSessionWorkDir,
        setSessionWorkspaceRoot: setSessionRoot,
      } = await import('../tools/workspace.js');

      const sessionId = 'ars_session_workdir_test';
      sessionIds.push(sessionId);
      setSessionRoot(sessionId, overrideDir);
      expect(resolveSessionWorkDir(sessionId, projectId)).toBe(overrideDir);
      clearSessionRoot(sessionId);
      expect(resolveSessionWorkDir(sessionId, projectId)).toBe(projectDir);
    });
  });
});
