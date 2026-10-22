import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { asSchema } from "../../../infrastructure/llm-runtime/tool-schema.js";
import { buildLoopToolSet } from '../loop-ai-tools.js';

describe('loop AI tool adapter', () => {
  it('keeps provider names stable when a colliding ID is disclosed later', () => {
    const definition = (id: string) => ({ id, label: id, description: id,
      category: 'read' as const, mutability: 'read' as const, resumeBehavior: 'none' as const,
      inputSchema: z.object({}) });
    const first = buildLoopToolSet([definition('mcp.a_b.c')], undefined, { stableNames: true });
    const expanded = buildLoopToolSet([definition('mcp.a_b.c'), definition('mcp.a.b_c')], undefined, { stableNames: true });
    expect(first.resolveModelToolName('mcp.a_b.c')).toBe(expanded.resolveModelToolName('mcp.a_b.c'));
    expect(expanded.resolveModelToolName('mcp.a_b.c')).not.toBe(expanded.resolveModelToolName('mcp.a.b_c'));
    expect(first.resolveToolId(expanded.resolveModelToolName('mcp.a.b_c')!)).toBeNull();
  });
  it('maps Synax dotted tool ids to provider-safe tool names', () => {
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

it('shares converted schemas across accounting and steps while preserving validation and updates', async () => {
  const definition = {
    id: 'file.read', label: 'Read', description: 'Read a file', category: 'read' as const,
    mutability: 'read' as const, resumeBehavior: 'auto' as const,
    inputSchema: z.object({ path: z.string() }),
  };
  const first = asSchema(buildLoopToolSet([definition]).tools.file_read.inputSchema);
  const next = asSchema(buildLoopToolSet([{ ...definition, description: 'Updated description' }]).tools.file_read.inputSchema);
  expect(next).toBe(first);
  expect(await next.jsonSchema).toBe(await first.jsonSchema);
  expect(await next.validate?.({ path: 'test.txt' })).toEqual({ success: true, value: { path: 'test.txt' } });
  expect(await next.validate?.({ path: 1 })).toMatchObject({ success: false });
  const updated = asSchema(buildLoopToolSet([{ ...definition, inputSchema: z.object({ path: z.string(), limit: z.number() }) }]).tools.file_read.inputSchema);
  expect(updated).not.toBe(first);
  expect(await updated.jsonSchema).toMatchObject({ required: ['path', 'limit'] });
});
