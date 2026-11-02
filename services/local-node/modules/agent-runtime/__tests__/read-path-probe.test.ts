import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool, ToolCallRecord } from '../contracts.js';
import { clearSessionFileReads, getSessionReadPaths, rebuildSessionFileReads, recordSessionFileDiscovery } from '../read-tracker.js';
import { fileReadTool } from '../tools/file-read.js';
import { fileListTool } from '../tools/file-list.js';
import { fileDeleteTool } from '../tools/file-delete.js';
import { rgTool } from '../tools/rg.js';
import * as execAsync from '../tools/exec-async.js';
import * as ripgrep from '../tools/ripgrep.js';
import * as workspace from '../tools/workspace.js';
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from '../tools/workspace.js';

const sessionId = 'read-path-probe-test';
let root: string;
const base = 'services/local-node/modules/agent-runtime';
const missingPath = `${base}/agent-session`;
const probes: [string, RegisteredTool, Record<string, unknown>][] = [
  ['rg search', rgTool, { query: 'completedAt:', path: missingPath, limit: 30, contextLines: 3 }],
  ['rg files', rgTool, { mode: 'files', pattern: '*.ts', path: missingPath }],
  ['file.list', fileListTool, { path: missingPath }],
  ['file.read', fileReadTool, { path: `${missingPath}/session.ts` }],
];

function execute(tool: RegisteredTool, args: Record<string, unknown>) {
  return Promise.resolve().then(() => tool.execute({
    sessionId, runId: null, stepId: null, toolCallId: 'probe',
    toolId: tool.id, category: tool.category, mutability: tool.mutability, args,
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-read-probe-'));
  fs.mkdirSync(path.join(root, base), { recursive: true });
  fs.writeFileSync(path.join(root, base, 'session.ts'), 'completedAt: null\n');
  setSessionWorkspaceRoot(sessionId, root);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionFileReads(sessionId);
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('recoverable read path probes', () => {
  it.each(probes)('%s returns an explicit miss rather than an execution failure or empty success', async (_, tool, args) => {
    const command = vi.spyOn(execAsync, 'runCommand');
    const result = await execute(tool, args);
    expect(result.outcome).toBeUndefined();
    expect(result.artifacts).toEqual([]);
    expect(result.result).toMatchObject({
      status: 'not_found', code: 'READ_PATH_NOT_FOUND', recoverable: true,
      path: args.path, reason: 'ENOENT',
      suggestedCall: { toolId: 'file.list', args: { path: base } },
    });
    expect(result.result).not.toHaveProperty('content');
    expect(result.result).not.toHaveProperty('hits');
    expect(result.result).not.toHaveProperty('files');
    expect(result.result).not.toHaveProperty('items');
    expect(command).not.toHaveBeenCalled();
    expect(getSessionReadPaths(sessionId)).toEqual([]);
  });

  it.each(probes)('%s also handles a guessed file-as-parent path', async (_, tool, args) => {
    const result = await execute(tool, { ...args, path: `${base}/session.ts/child` });
    expect(result.result).toMatchObject({ status: 'not_found', reason: 'ENOTDIR' });
  });

  it.each(probes)('%s does not suppress a lost workspace', async (_, tool, args) => {
    fs.rmSync(root, { recursive: true });
    await expect(execute(tool, args)).rejects.toThrow();
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves a real %s failure at the target', async code => {
    const original = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]).endsWith('/session.ts')) {
        throw Object.assign(new Error(`Cannot inspect target: ${code}`), { code });
      }
      return original(...args);
    }) as typeof fs.statSync);
    for (const [, tool, args] of probes) {
      await expect(execute(tool, { ...args, path: `${base}/session.ts` })).rejects.toThrow(code);
    }
  });

  it('checks a previously discovered file again instead of trusting stale discovery', async () => {
    const target = `${base}/session.ts`;
    recordSessionFileDiscovery(sessionId, target);
    fs.unlinkSync(path.join(root, target));
    expect((await execute(fileReadTool, { path: target })).result).toMatchObject({ status: 'not_found' });
  });

  it('retains bounded close-file suggestions for a missing read', async () => {
    const result = await execute(fileReadTool, { path: `${missingPath}/session.ts` });
    expect(result.result).toMatchObject({ suggestions: [`${base}/session.ts`] });
  });

  it('keeps recovery suggestions within the existing file visibility policy', async () => {
    fs.writeFileSync(path.join(root, 'config.pem'), 'private fixture');
    fs.writeFileSync(path.join(root, 'config.ts'), 'public fixture');
    const result = await execute(fileReadTool, { path: 'config' });
    expect(result.result).toMatchObject({ suggestions: ['config.ts'] });
    await expect(execute(fileReadTool, { path: 'config.pem' })).rejects.toThrow();
  });

  it('never rebuilds a read credential from a miss even if the file later appears', async () => {
    const target = `${missingPath}/session.ts`;
    rebuildSessionFileReads(sessionId, [{
      toolId: 'file.read', status: 'completed', inputRef: { path: target },
      outputRef: { status: 'not_found', code: 'READ_PATH_NOT_FOUND' },
    } as ToolCallRecord]);
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), 'new content\n');
    rebuildSessionFileReads(sessionId, [{
      toolId: 'file.read', status: 'completed', inputRef: { path: target },
      outputRef: { status: 'not_found', code: 'READ_PATH_NOT_FOUND' },
    } as ToolCallRecord]);
    expect(getSessionReadPaths(sessionId)).toEqual([]);
  });

  it('does not suppress destructive operations against a missing target', async () => {
    await expect(execute(fileDeleteTool, { path: missingPath })).rejects.toThrow(/not found/i);
  });

  it('does not turn a sandbox rejection into recovery feedback', async () => {
    const denial = new Error('Sandbox access denied');
    vi.spyOn(workspace, 'resolveWorkspacePath').mockImplementation(() => { throw denial; });
    for (const [, tool, args] of probes) {
      await expect(execute(tool, args)).rejects.toBe(denial);
    }
  });

  it('does not suppress ENOENT from the search executor', async () => {
    const failure = Object.assign(new Error('ENOENT: search executor unavailable'), { code: 'ENOENT' });
    vi.spyOn(ripgrep, 'resolveRipgrep').mockResolvedValue('/fake/rg');
    vi.spyOn(execAsync, 'runCommand').mockRejectedValue(failure);
    await expect(execute(rgTool, { query: 'completedAt:', path: base })).rejects.toBe(failure);
  });

  it('keeps missing external roots as errors rather than suggesting unrelated workspace paths', async () => {
    const external = path.join(root, '..', `${path.basename(root)}-offline`, 'file.ts');
    const resolve = workspace.resolveWorkspacePath;
    // Model a sandbox-approved external path; availability remains a separate check.
    vi.spyOn(workspace, 'resolveWorkspacePath').mockImplementation((input, session) =>
      input === external ? external : resolve(input, session));
    for (const [, tool, args] of probes) {
      await expect(execute(tool, { ...args, path: external })).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
