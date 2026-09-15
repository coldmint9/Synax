import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClientHandler, createWorkspaceClientHandler } from '../protocol/reverse-handlers.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-acp-fs-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

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
    await expect(handler.readTextFile!({ sessionId: 'native', path: 'escape' })).rejects.toThrow(/outside/i);
    // Blocked segment names were released; the remaining extension rule still filters.
    expect(await handler.readTextFile!({ sessionId: 'native', path: '.env' })).toEqual({ content: 'secret' });
    await expect(handler.readTextFile!({ sessionId: 'native', path: 'cert.pem' })).rejects.toThrow(/protected/i);
  });
});
