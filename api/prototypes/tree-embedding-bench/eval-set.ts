import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CodeMapCodeIndex } from '../../services/contracts/code-map.js';
import type { RetrievalTask } from './contracts.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVAL_SET_PATH = path.join(MODULE_DIR, 'eval-set.json');
export const SYNAX_EVAL_SET_PATH = path.join(MODULE_DIR, 'eval-set-synax.json');

export type EvalDifficulty = 'easy' | 'medium' | 'hard';

export interface EvalQuery {
  lang: 'en' | 'zh' | string;
  text: string;
}

export interface EvalTarget {
  file: string;
  symbol: string;
}

export interface EvalCase {
  id: string;
  category: string;
  difficulty: EvalDifficulty;
  target: EvalTarget;
  queries: EvalQuery[];
}

export interface EvalSetFile {
  version: number;
  description?: string;
  cases: EvalCase[];
}

export interface ResolvedEvalCase extends EvalCase {
  targetSymbolId: string;
}

export interface ResolvedEvalTask {
  caseId: string;
  queryId: string;
  lang: string;
  query: string;
  category: string;
  difficulty: EvalDifficulty;
  target: EvalTarget;
  targetSymbolId: string;
}

export interface EvalSetSummary {
  path: string;
  version: number;
  caseCount: number;
  queryCount: number;
  resolvedCaseCount: number;
  unresolved: Array<{ caseId: string; target: EvalTarget }>;
}

export function loadEvalSetFile(evalSetPath = DEFAULT_EVAL_SET_PATH): EvalSetFile {
  const raw = fs.readFileSync(evalSetPath, 'utf8');
  return JSON.parse(raw) as EvalSetFile;
}

export function resolveSymbolId(
  index: CodeMapCodeIndex,
  target: EvalTarget,
): string | undefined {
  const file = index.files.find((f) => f.path === target.file);
  if (!file) return undefined;
  return index.symbols.find((s) => s.fileId === file.id && s.name === target.symbol)?.id;
}

export function resolveEvalSet(
  evalSet: EvalSetFile,
  index: CodeMapCodeIndex,
): { cases: ResolvedEvalCase[]; tasks: ResolvedEvalTask[]; unresolved: EvalSetSummary['unresolved'] } {
  const cases: ResolvedEvalCase[] = [];
  const tasks: ResolvedEvalTask[] = [];
  const unresolved: EvalSetSummary['unresolved'] = [];

  for (const evalCase of evalSet.cases) {
    const targetSymbolId = resolveSymbolId(index, evalCase.target);
    if (!targetSymbolId) {
      unresolved.push({ caseId: evalCase.id, target: evalCase.target });
      continue;
    }
    cases.push({ ...evalCase, targetSymbolId });
    evalCase.queries.forEach((q, idx) => {
      tasks.push({
        caseId: evalCase.id,
        queryId: `${evalCase.id}:${idx}`,
        lang: q.lang,
        query: q.text,
        category: evalCase.category,
        difficulty: evalCase.difficulty,
        target: evalCase.target,
        targetSymbolId,
      });
    });
  }

  return { cases, tasks, unresolved };
}

export function loadEvalTasks(
  index: CodeMapCodeIndex,
  evalSetPath = DEFAULT_EVAL_SET_PATH,
): RetrievalTask[] {
  const evalSet = loadEvalSetFile(evalSetPath);
  const { tasks } = resolveEvalSet(evalSet, index);
  return tasks.map((t) => ({
    id: t.queryId,
    query: t.query,
    targetSymbolId: t.targetSymbolId,
  }));
}

export function summarizeEvalSet(
  index: CodeMapCodeIndex,
  evalSetPath = DEFAULT_EVAL_SET_PATH,
): EvalSetSummary {
  const evalSet = loadEvalSetFile(evalSetPath);
  const { cases, tasks, unresolved } = resolveEvalSet(evalSet, index);
  return {
    path: evalSetPath,
    version: evalSet.version,
    caseCount: evalSet.cases.length,
    queryCount: tasks.length,
    resolvedCaseCount: cases.length,
    unresolved,
  };
}

export function evalTasksToRetrievalTasks(tasks: ResolvedEvalTask[]): RetrievalTask[] {
  return tasks.map((t) => ({
    id: t.queryId,
    query: t.query,
    targetSymbolId: t.targetSymbolId,
  }));
}

export interface EvalRunRow {
  caseId: string;
  queryId: string;
  lang: string;
  query: string;
  difficulty: EvalDifficulty;
  targetSymbol: string;
  targetFile: string;
  rank: number;
  topSymbol: string;
  topFile: string;
  similarity: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
}

export function groupEvalRowsByCase(rows: EvalRunRow[]): Map<string, EvalRunRow[]> {
  const map = new Map<string, EvalRunRow[]>();
  for (const row of rows) {
    const list = map.get(row.caseId) ?? [];
    list.push(row);
    map.set(row.caseId, list);
  }
  return map;
}
