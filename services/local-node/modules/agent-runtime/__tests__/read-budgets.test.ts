import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asSchema } from '../../../infrastructure/llm-runtime/tool-schema.js';
import { describe, expect, it } from 'vitest';
import { buildLoopToolSet } from '../loop-ai-tools.js';
import { fileListTool } from '../tools/file-list.js';
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from '../tools/workspace.js';
import { rgTool } from '../tools/rg.js';

const sessionId = 'read-budget-test';
const toolInput = (toolId: string, args: unknown) => ({
  sessionId,
  runId: null,
  stepId: null,
  toolCallId: `read-budget-${toolId}`,
  toolId,
  category: 'read',
  mutability: 'read',
  args,
} as never);

describe('read tool budgets', () => {
  it('accepts oversized safe integers while rejecting invalid budget values', async () => {
    const rgSchema = rgTool.inputSchema!;
    const fileListSchema = fileListTool.inputSchema!;
    for (const limit of [201, 301, Number.MAX_SAFE_INTEGER]) {
      expect(rgSchema.safeParse({ query: 'needle', limit }).success).toBe(true);
      expect(fileListSchema.safeParse({ limit }).success).toBe(true);
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(rgSchema.safeParse({ query: 'needle', limit: value }).success).toBe(false);
      expect(fileListSchema.safeParse({ limit: value }).success).toBe(false);
      if (value !== 0) {
        expect(rgSchema.safeParse({ query: 'needle', contextLines: value }).success).toBe(false);
      }
    }
    expect(rgSchema.safeParse({ query: 'needle', contextLines: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(rgSchema.safeParse({ query: 'needle', contextLines: 0 }).success).toBe(true);
  });

  it('keeps model-visible schemas aligned with effective caps', async () => {
    const modelTools = buildLoopToolSet([rgTool, fileListTool]);
    const rgModel = modelTools.tools[modelTools.resolveModelToolName('rg')!];
    const fileListModel = modelTools.tools[modelTools.resolveModelToolName('file.list')!];
    const rgSchema = await asSchema(rgModel.inputSchema).jsonSchema;
    const fileListSchema = await asSchema(fileListModel.inputSchema).jsonSchema;
    const rgProperties = rgSchema.properties as Record<string, { description?: string; maximum?: number }>;
    const fileListProperties = fileListSchema.properties as Record<string, { description?: string; maximum?: number }>;

    expect(rgProperties.limit).toHaveProperty('maximum', Number.MAX_SAFE_INTEGER);
    expect(rgProperties.limit.description).toContain('effective cap 200');
    expect(rgProperties.contextLines).toHaveProperty('maximum', Number.MAX_SAFE_INTEGER);
    expect(rgProperties.contextLines.description).toContain('effective cap 5');
    expect(fileListProperties.limit).toHaveProperty('maximum', Number.MAX_SAFE_INTEGER);
    expect(fileListProperties.limit.description).toContain('effective cap 300');
  });

  it('clamps rg search and file-list execution budgets and reports them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-read-budgets-'));
    setSessionWorkspaceRoot(sessionId, root);
    try {
      fs.writeFileSync(
        path.join(root, 'matches.ts'),
        Array.from({ length: 205 }, (_, index) => `const needle${index} = true;`).join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(root, 'listed'));
      for (let index = 0; index < 301; index++) {
        fs.writeFileSync(path.join(root, 'listed', `entry-${String(index).padStart(3, '0')}.ts`), '', 'utf8');
      }

      const searchArgs = rgTool.inputSchema!.parse({
        query: 'needle', path: 'matches.ts', limit: 201, contextLines: 6,
      });
      const search = await rgTool.execute(toolInput('rg', searchArgs));
      expect(search.result).toMatchObject({ effectiveLimit: 200, effectiveContextLines: 5 });
      expect((search.result as { hits: unknown[] }).hits).toHaveLength(200);

      const filesArgs = rgTool.inputSchema!.parse({
        mode: 'files', pattern: '*.ts', path: 'listed', limit: 301,
      });
      const files = await rgTool.execute(toolInput('rg', filesArgs));
      expect(files.result).toMatchObject({ effectiveLimit: 300, effectiveContextLines: 0 });
      expect((files.result as { files: unknown[] }).files).toHaveLength(300);

      const listArgs = fileListTool.inputSchema!.parse({ path: 'listed', limit: 301 });
      const listing = await fileListTool.execute(toolInput('file.list', listArgs));
      expect(listing.result).toMatchObject({ effectiveLimit: 300, truncated: true, hasMore: true });
      expect((listing.result as { items: unknown[] }).items).toHaveLength(300);
    } finally {
      clearSessionWorkspaceRoot(sessionId);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
