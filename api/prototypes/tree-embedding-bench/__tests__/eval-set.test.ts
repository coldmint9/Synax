import { describe, expect, it } from 'vitest';

import {
  loadEvalSetFile,
  resolveEvalSet,
  resolveSymbolId,
  SYNAX_EVAL_SET_PATH,
} from '../eval-set.js';
import { loadFixtureIndex } from '../fixtures.js';

describe('eval-set', () => {
  it('加载 fixture 测评集 JSON', () => {
    const evalSet = loadEvalSetFile();
    expect(evalSet.version).toBe(1);
    expect(evalSet.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of evalSet.cases) {
      expect(c.queries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('fixture 测评集 target 可解析为 symbolId', async () => {
    const fixture = await loadFixtureIndex();
    const evalSet = loadEvalSetFile();
    const { cases, tasks, unresolved } = resolveEvalSet(evalSet, fixture.codeIndex);

    expect(unresolved.length).toBeLessThanOrEqual(3);
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(tasks.length).toBeGreaterThanOrEqual(cases.length * 2);

    for (const task of tasks) {
      expect(task.targetSymbolId).toMatch(/^sym_/);
      expect(resolveSymbolId(fixture.codeIndex, task.target)).toBe(task.targetSymbolId);
    }
  });

  it('Synax 测评集 JSON 结构合法', () => {
    const evalSet = loadEvalSetFile(SYNAX_EVAL_SET_PATH);
    expect(evalSet.cases.length).toBeGreaterThanOrEqual(10);
    expect(evalSet.description).toMatch(/Synax/i);
  });
});
