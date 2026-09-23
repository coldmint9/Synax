import { describe, it, expect } from 'vitest';
import { extensionStore } from '../extension-store.js';
import { customExtensionSchema } from '../schemas.js';
describe('project extensions', () => {
  it('preserves legacy capabilities until explicitly changed and isolates projects', () => {
    expect(extensionStore.active('ext-a', 'tool', 'file.read')).toBe(true);
    extensionStore.setState('ext-a', 'tool', 'file.read', {
      installed: false,
      enabled: false,
    });
    expect(extensionStore.active('ext-a', 'tool', 'file.read')).toBe(false);
    expect(extensionStore.active('ext-b', 'tool', 'file.read')).toBe(true);
    extensionStore.setState('ext-a', 'tool', 'file.read', {
      installed: true,
      enabled: false,
    });
    expect(extensionStore.state('ext-a', 'tool', 'file.read')).toEqual({
      installed: true,
      enabled: false,
    });
    extensionStore.setState('ext-a', 'tool', 'file.read', {
      installed: true,
      enabled: true,
    });
    expect(extensionStore.active('ext-a', 'tool', 'file.read')).toBe(true);
  });
  it('requires a matching custom definition and rejects unsupported URLs', () => {
    expect(
      customExtensionSchema.safeParse({
        kind: 'tool',
        name: 'Example',
        description: 'Demo',
      }).success,
    ).toBe(false);
    expect(
      customExtensionSchema.safeParse({
        kind: 'mcp',
        name: 'Example',
        description: 'Demo',
        mcp: {
          id: 'x',
          name: 'X',
          transport: 'http',
          url: 'file:///etc/passwd',
        },
      }).success,
    ).toBe(false);
    expect(
      customExtensionSchema.safeParse({
        kind: 'tool',
        name: 'Example',
        description: 'Demo',
        tool: {
          mode: 'command',
          command: 'node',
          inputSchema: { type: 'object', properties: {} },
        },
      }).success,
    ).toBe(true);
  });
});
