import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileDeleteTool } from '../tools/file-delete.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { toolRegistry } from '../tool-registry.js';
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from '../tools/workspace.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

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

describe('fileDeleteTool', () => {
  it('deletes a workspace file', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-file-delete-'));
    tempDirs.push(projectDir);
    const filePath = path.join(projectDir, 'obsolete.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n', 'utf8');

    const sessionId = 'ars_file_delete_test';
    sessionIds.push(sessionId);
    setSessionWorkspaceRoot(sessionId, projectDir);

    const result = fileDeleteTool.execute({
      sessionId,
      runId: null,
      stepId: null,
      toolCallId: 'tool_file_delete_test',
      toolId: 'file.delete',
      category: 'write',
      mutability: 'write',
      args: { path: 'obsolete.ts' },
    });

    expect(result.result).toEqual({ path: 'obsolete.ts', deleted: true });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects missing paths and directories', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-file-delete-reject-'));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, 'pkg'));

    const sessionId = 'ars_file_delete_reject';
    sessionIds.push(sessionId);
    setSessionWorkspaceRoot(sessionId, projectDir);

    const baseInput = {
      sessionId,
      runId: null,
      stepId: null,
      toolCallId: 'tool_file_delete_reject',
      toolId: 'file.delete',
      category: 'write' as const,
      mutability: 'write' as const,
    };

    expect(() => fileDeleteTool.execute({ ...baseInput, args: { path: 'missing.ts' } }))
      .toThrow(/File not found/);

    expect(() => fileDeleteTool.execute({ ...baseInput, args: { path: 'pkg' } }))
      .toThrow(/only removes files/);
  });

  it('requires write permission approval before deleting', async () => {
    resetAgentRuntimeFixtures();
    const session = agentSessionRuntime.create(executorInput);
    const call = await toolRegistry.execute(session.id, 'file.delete', {
      path: 'tmp/agent-runtime-delete.txt',
    });

    expect(call.record.status).toBe('pending');
    expect(call.permission?.action).toBe('ask');
    expect(call.permission?.internalGate).toBe('delete');
  });
});
