import { describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, ClientSideConnection } from '@agentclientprotocol/sdk';
import { openAcpSession } from '../protocol/acp-connection.js';

describe('ACP recovery contract', () => {
  it.each([
    ['newSession', undefined, { sessionCapabilities: { additionalDirectories: {} } }],
    ['loadSession', 'stored-session', { loadSession: true, sessionCapabilities: { additionalDirectories: {} } }],
    ['resumeSession', 'stored-session', { sessionCapabilities: { resume: {}, additionalDirectories: {} } }],
  ] as const)('passes additional directories through %s', async (method, acpSessionId, capabilities) => {
    const request = vi.fn(async () => ({ sessionId: 'new-session' }));
    const conn = { [method]: request } as unknown as ClientSideConnection;
    const additionalDirectories = ['/reference-a', '/reference-b'];
    await openAcpSession(conn, { cwd: '/primary', acpSessionId, capabilities: capabilities as AgentCapabilities, additionalDirectories });
    expect(request).toHaveBeenCalledWith({ cwd: '/primary', mcpServers: [], additionalDirectories,
      ...(acpSessionId ? { sessionId: acpSessionId } : {}) });
  });
  it('keeps single-directory request shape compatible', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'new-session' }));
    await openAcpSession({ newSession } as unknown as ClientSideConnection, { cwd: '/primary', capabilities: {} });
    expect(newSession).toHaveBeenCalledWith({ cwd: '/primary', mcpServers: [] });
  });
  it('rejects reference roots when the agent does not advertise support', async () => {
    const newSession = vi.fn();
    const setSessionConfigOption = vi.fn();
    await expect(openAcpSession({ newSession, setSessionConfigOption } as unknown as ClientSideConnection, {
      cwd: '/primary', capabilities: {}, additionalDirectories: ['/reference'],
    })).rejects.toThrow(/does not advertise/);
    expect(newSession).not.toHaveBeenCalled();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });
  it('explicitly clears removed directories for a capable restored session', async () => {
    const loadSession = vi.fn(async () => ({}));
    await openAcpSession({ loadSession } as unknown as ClientSideConnection, {
      cwd: '/primary', acpSessionId: 'stored-session', additionalDirectories: [],
      capabilities: { loadSession: true, sessionCapabilities: { additionalDirectories: {} } },
    });
    expect(loadSession).toHaveBeenCalledWith({ cwd: '/primary', sessionId: 'stored-session', mcpServers: [], additionalDirectories: [] });
  });
  it('does not silently create a new context when a stored session cannot be restored', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'different-session' }));
    const conn = { newSession } as unknown as ClientSideConnection;
    await expect(openAcpSession(conn, {
      cwd: '/tmp', acpSessionId: 'stored-session', capabilities: {},
    })).rejects.toThrow(/restor|resum/i);
    expect(newSession).not.toHaveBeenCalled();
  });
});
