import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientHandler, createWorkspaceClientHandler, createWorkspaceClientHandlerForSession } from '../protocol/reverse-handlers.js';
import { agentRuntimeStore } from '../../agent-runtime/session-store.js';
import type { AgentSession } from '../../agent-runtime/contracts.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-acp-fs-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('ACP filesystem callback boundary', () => {
  it('does not expose filesystem callbacks without a bound workspace', async () => {
    const handler = createClientHandler();
    await expect(handler.readTextFile!({ sessionId: 'native', path: '/etc/passwd' })).rejects.toThrow(/workspace/i);
    await expect(handler.writeTextFile!({ sessionId: 'native', path: path.join(root, 'x'), content: 'x' })).rejects.toThrow(/not supported/i);
  });
  it('honors scoped reads, refuses symlink escapes, and no longer blocks segment names', async () => {
    const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'readme'), 'one\ntwo\nthree');
    await fs.writeFile(path.join(root, 'outside'), 'private');
    await fs.symlink(path.join(root, 'outside'), path.join(workspace, 'escape'));
    await fs.writeFile(path.join(workspace, '.env'), 'secret');
    await fs.writeFile(path.join(workspace, 'cert.pem'), 'key');
    const handler = createWorkspaceClientHandler(workspace);
    expect(await handler.readTextFile!({ sessionId: 'native', path: 'readme', line: 2, limit: 1 })).toEqual({ content: 'two' });
    await expect(handler.readTextFile!({ sessionId: 'native', path: 'escape' })).rejects.toThrow(/boundary|escape/i);
    // Blocked segment names were released; the remaining extension rule still filters.
    expect(await handler.readTextFile!({ sessionId: 'native', path: '.env' })).toEqual({ content: 'secret' });
    await expect(handler.readTextFile!({ sessionId: 'native', path: 'cert.pem' })).rejects.toThrow(/blocked extension/i);
  });
  it('reads snapshot reference roots while retaining extension and symlink boundaries', async () => {
    const primary = path.join(root, 'primary');
    const reference = path.join(root, 'reference');
    await fs.mkdir(primary); await fs.mkdir(reference);
    await fs.writeFile(path.join(reference, 'readme'), 'reference data');
    await fs.writeFile(path.join(reference, 'cert.pem'), 'key');
    await fs.writeFile(path.join(root, 'outside'), 'private');
    await fs.symlink(path.join(root, 'outside'), path.join(reference, 'escape'));
    await fs.symlink(path.join(reference, 'readme'), path.join(primary, 'linked-reference'));
    const workspaceRoots = [
      { id: 'main', name: 'Main', path: primary, role: 'primary', status: 'available' },
      { id: 'ref', name: 'Reference', path: reference, role: 'reference', status: 'available' },
    ];
    vi.spyOn(agentRuntimeStore, 'tryGetSession').mockImplementation(id => id === 'owner'
      ? { id, projectId: 'main', permissionRules: [], sessionMetadata: { backend: { workDir: primary, workspaceRoots } } } as unknown as AgentSession
      : undefined);
    const handler = createWorkspaceClientHandlerForSession(primary, 'owner');
    const read = (file: string) => handler.readTextFile!({ sessionId: 'native', path: file });
    expect(await read(path.join(reference, 'readme'))).toEqual({ content: 'reference data' });
    expect(await read('linked-reference')).toEqual({ content: 'reference data' });
    await expect(read(path.join(reference, 'cert.pem'))).rejects.toThrow(/blocked extension/i);
    await expect(read(path.join(reference, 'escape'))).rejects.toThrow(/boundary|escape/i);
    workspaceRoots.pop();
    await expect(read(path.join(reference, 'readme'))).rejects.toThrow(/boundary|escape/i);
  });
});
