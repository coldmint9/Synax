import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-project-root-'));
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
});
