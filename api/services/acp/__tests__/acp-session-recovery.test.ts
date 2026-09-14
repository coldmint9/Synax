import { describe, expect, it, vi } from 'vitest';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import { openAcpSession } from '../protocol/acp-connection.js';

describe('ACP recovery contract', () => {
  it('does not silently create a new context when a stored session cannot be restored', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'different-session' }));
    const conn = { newSession } as unknown as ClientSideConnection;
    await expect(openAcpSession(conn, {
      cwd: '/tmp', acpSessionId: 'stored-session', capabilities: {},
    })).rejects.toThrow(/restor|resum/i);
    expect(newSession).not.toHaveBeenCalled();
  });
});
