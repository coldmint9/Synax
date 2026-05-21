import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchForest, scanCodeMap, search, streamAnalyzerSse } from '../analyzer-service.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-analyzer-'));
  fs.mkdirSync(path.join(dir, 'src', 'feature'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'feature', 'index.ts'),
    [
      'import { helperValue } from "../shared/helper";',
      'export function helloWorld() {',
      '  return helperValue + 1;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'shared', 'helper.ts'),
    [
      'export const helperValue = 42;',
      'export function formatValue(input: number) {',
      '  return `value:${input}`;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# sample workspace');
  fs.writeFileSync(path.join(dir, 'bun.lock'), '{ "lockfileVersion": 0 }');
  return dir;
}

describe('local analyzer service', () => {
  it('scans, caches, and exposes the local analyzer workflow', async () => {
    const workDir = makeWorkspace();

    const scan = await scanCodeMap({
      projectId: 'analyzer-service-scan',
      workDir,
      include: ['all'],
    });

    expect(scan.codeIndex.files.length).toBeGreaterThan(0);
    expect(scan.codeIndex.files.map((file) => file.path).sort()).toEqual([
      'src/feature/index.ts',
      'src/shared/helper.ts',
    ]);
    expect(scan.codeIndex.symbols.some((symbol) => symbol.name === 'helloWorld')).toBe(true);
    expect(scan.moduleMap?.topDirs.length).toBeGreaterThan(0);
    expect(scan.communities?.length).toBeGreaterThan(0);
    expect(scan.semanticGraph.nodes.length).toBeGreaterThan(0);

    const hits = await search({
      projectId: 'analyzer-service-scan',
      query: 'helloWorld',
      mode: 'keyword',
      topK: 10,
    });
    expect(hits.hits.length).toBeGreaterThan(0);

    const events: Array<{ type: string }> = [];
    for await (const event of streamAnalyzerSse('/analyze', {
      projectId: 'analyzer-service-stream',
      source: { kind: 'localPath', localPath: workDir },
      workDir,
      locale: 'en',
    })) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe('analysis_completed');

    const forest = await fetchForest('analyzer-service-stream');
    expect(forest?.nodes[forest.rootId]).toBeTruthy();
    expect(Object.values(forest?.nodes ?? {}).some((node) => node.type === 'feature')).toBe(true);
  });
});
