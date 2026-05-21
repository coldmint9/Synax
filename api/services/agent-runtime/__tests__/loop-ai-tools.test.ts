import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { buildLoopToolSet } from '../loop-ai-tools.js';

describe('loop AI tool adapter', () => {
  it('maps Synapse dotted tool ids to provider-safe tool names', () => {
    const toolSet = buildLoopToolSet([
      {
        id: 'file.read',
        label: 'Read File',
        description: 'Read a file.',
        category: 'read',
        mutability: 'read',
        resumeBehavior: 'auto',
        inputSchema: z.object({ path: z.string() }),
      },
    ]);

    expect(toolSet.activeTools).toEqual(['file_read']);
    expect(toolSet.resolveToolId('file_read')).toBe('file.read');
    expect(toolSet.resolveToolId('file.read')).toBe('file.read');
    expect(toolSet.resolveModelToolName('file.read')).toBe('file_read');
    expect(toolSet.tools).toHaveProperty('file_read');
  });
});
