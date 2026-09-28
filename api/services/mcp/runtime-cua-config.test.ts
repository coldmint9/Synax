import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeCuaConfig, setRuntimeCuaConnection } from './runtime-cua-config.js';

afterEach(() => setRuntimeCuaConnection(null));
describe('ephemeral Cua MCP connection', () => {
  const connection = { generation: 'one', command: '/usr/local/bin/cua-driver', args: ['mcp', '--socket', '/tmp/synax.sock'], environment: [{ name: 'CUA_DRIVER_EMBEDDED', value: '1' }] };
  it('accepts a trusted parent connection and rejects malformed executable paths', () => {
    expect(setRuntimeCuaConnection(connection)).toBe(true);
    expect(getRuntimeCuaConfig()).toMatchObject({ command: connection.command, args: connection.args, env: { CUA_DRIVER_EMBEDDED: '1' } });
    expect(setRuntimeCuaConnection(connection)).toBe(false);
    expect(() => setRuntimeCuaConnection({ ...connection, command: 'sh -c' })).toThrow();
  });
  it('removes the old private endpoint when Electron disconnects', () => {
    setRuntimeCuaConnection(connection);
    expect(setRuntimeCuaConnection(null)).toBe(true);
    expect(getRuntimeCuaConfig()).toBeNull();
  });
});
