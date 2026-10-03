import fs from 'node:fs';
import { asSchema } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { buildLoopToolSet } from '../loop-ai-tools.js';
import { toolRegistry } from '../tool-registry.js';
import { specialistSpecSchema } from '../specialist-profile.js';

const modelTools = buildLoopToolSet(toolRegistry.list());
function modelTool(id: string) {
  const name = modelTools.resolveModelToolName(id);
  if (!name) throw new Error(`Missing tool ${id}`);
  return modelTools.tools[name];
}
async function definition(id: string) {
  const tool = modelTool(id);
  if (typeof tool.description !== 'string') throw new Error(`Expected static description for ${id}`);
  return { description: tool.description, schema: await asSchema(tool.inputSchema).jsonSchema };
}
const specialist = {
  name: 'Scoped writer', role: 'Implementer', instructions: 'Edit the assigned files.',
  capabilities: ['file.patch'], skillIds: [],
};

describe('model-visible builtin tool contracts', () => {
  it('exports every registered builtin and keeps the inventory complete', async () => {
    const inventory = fs.readFileSync(new URL('../../../../../docs/builtin-tool-contracts.md', import.meta.url), 'utf8');
    for (const tool of toolRegistry.list()) {
      expect(inventory, tool.id).toContain(`\`${tool.id}\``);
      const exposed = await definition(tool.id);
      expect(exposed.description.trim(), tool.id).not.toBe('');
      expect(exposed.schema, tool.id).toMatchObject({ type: 'object' });
    }
  });

  it('exposes safe write scopes through the actual SDK schema conversion', async () => {
    const exposed = await definition('subagent.delegate');
    expect(exposed.description).toContain('Only one specialist writer');
    expect(exposed.description).toContain('relative to the child working directory');
    expect(exposed.schema).toMatchObject({ properties: { specialist: { properties: {
      writeScope: { description: expect.stringContaining('directory includes its descendants'), items: {
        description: expect.stringContaining('No absolute paths'),
      } },
      capabilities: { description: expect.stringContaining('Write capabilities require writeScope') },
    } } } });
    expect(specialistSpecSchema.parse({ ...specialist, writeScope: ['client/src/', './services/local-node'] }).writeScope)
      .toEqual(['client/src', 'services/local-node']);
    for (const path of ['.', '/', '/tmp/file', '../file', 'client/../file', 'client/**', '*.ts', 'client\\src', '~/file', ' file', 'file ', 'file%20', 'C:/file']) {
      expect(specialistSpecSchema.safeParse({ ...specialist, writeScope: [path] }).success, path).toBe(false);
    }
  });

  it('documents non-exportable media and browser argument conditions', async () => {
    const media = await definition('media.read');
    expect(media.description).toContain('exactly one');
    expect(media.description).toContain('50 MiB');
    const mediaSchema = toolRegistry.get('media.read').inputSchema!;
    expect(mediaSchema.safeParse({ assetId: 'asset_id' }).success).toBe(true);
    expect(mediaSchema.safeParse({ path: 'image.png' }).success).toBe(true);
    expect(mediaSchema.safeParse({}).success).toBe(false);
    expect(mediaSchema.safeParse({ assetId: 'asset_id', path: 'image.png' }).success).toBe(false);
    expect((await definition('browser.navigate')).description).toContain('url takes precedence');
    expect((await definition('browser.network')).description).toContain('seq takes precedence');
    expect((await definition('browser.wait')).description).toContain('exactly one');
    const waitSchema = toolRegistry.get('browser.wait').inputSchema!;
    expect(waitSchema.safeParse({ text: 'Ready' }).success).toBe(true);
    expect(waitSchema.safeParse({}).success).toBe(false);
    expect(waitSchema.safeParse({ text: 'Ready', selector: 'button' }).success).toBe(false);
  });

  it('exposes question and plan dependency constraints omitted by JSON Schema', async () => {
    expect((await definition('human.ask')).description).toContain('Question IDs must be unique');
    expect((await definition('plan.propose')).description).toContain('earlier steps');
    const askSchema = toolRegistry.get('human.ask').inputSchema!;
    const question = { id: 'choice', type: 'single_select', label: 'Choose', options: [{ value: 'a', label: 'A' }] };
    expect(askSchema.safeParse({ title: 'Choice', questions: [{ ...question, recommended: ['a'] }] }).success).toBe(true);
    expect(askSchema.safeParse({ title: 'Choice', questions: [{ ...question, recommended: ['b'] }] }).success).toBe(false);
    expect(askSchema.safeParse({ title: 'Choice', questions: [question, question] }).success).toBe(false);
    const plan = { title: 'Plan', objective: 'Do work', acceptanceCriteria: ['Done'], steps: [
      { id: 'first', title: 'First', description: 'First step' },
      { id: 'second', title: 'Second', description: 'Second step', dependsOn: ['first'] },
    ] };
    const planSchema = toolRegistry.get('plan.propose').inputSchema!;
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, steps: [...plan.steps].reverse() }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, humanAcceptanceCriteria: ['Foreign'] }).success).toBe(false);
  });

  it('corrects search defaults and does not warn against supported hyphen patterns', async () => {
    const rg = await definition('rg');
    expect(rg.description).not.toContain('never begin');
    expect(rg.schema).toMatchObject({ properties: {
      limit: { description: expect.stringContaining('files default 100') },
      query: { description: expect.stringContaining('Leading hyphens') },
    } });
    expect(toolRegistry.get('rg').inputSchema!.safeParse({ query: '--color' }).success).toBe(true);
    expect(toolRegistry.get('rg').inputSchema!.safeParse({ mode: 'files', pattern: '**/*.ts' }).success).toBe(true);
    expect(toolRegistry.get('rg').inputSchema!.safeParse({ mode: 'files', query: '**/*.ts' }).success).toBe(false);
  });

  it('exposes image adapter conditions before execution', async () => {
    const image = await definition('media.generate');
    expect(image.schema).toMatchObject({ properties: {
      api: { description: expect.stringContaining('responses requires n=1') },
      size: { description: expect.stringContaining('655360-8294400') },
      partialImages: { description: expect.stringContaining('rejected by SDK adapters') },
      aspectRatio: { description: expect.stringContaining('Images/Responses reject') },
    } });
    expect(image.description).toContain('smaller than 50 MB');
    const schema = toolRegistry.get('media.generate').inputSchema!;
    expect(schema.safeParse({ prompt: 'Draw a leaf', size: '1024x1024' }).success).toBe(true);
    expect(schema.safeParse({ prompt: 'Draw a leaf', size: '1024x0' }).success).toBe(false);
  });

  it('describes the actual batch search input shape', async () => {
    const web = await definition('webSearch');
    expect(web.description).toContain('array of 1-5 query strings');
    const schema = toolRegistry.get('webSearch').inputSchema!;
    expect(schema.safeParse({ queries: ['first', 'second'], domains: ['example.com'] }).success).toBe(true);
    expect(schema.safeParse({ query: 'first', queries: ['second'] }).success).toBe(false);
    expect(schema.safeParse({ queries: [{ query: 'first', limit: 2 }] }).success).toBe(false);
    expect(schema.safeParse({ query: 'first', domains: ['https://example.com'] }).success).toBe(false);
  });
});
