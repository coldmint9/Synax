import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOneFile } from '../../services/analyzer/parse-lib.js';
import type { CodeMapCodeIndex } from '../../services/contracts/code-map.js';
import type { FileEntry, SymbolEntry } from '../../services/contracts/forest.js';

import type { ParsedFixtureIndex, RetrievalTask, SymbolContext } from './contracts.js';
import { loadEvalTasks } from './eval-set.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(MODULE_DIR, 'fixtures', 'samples');

export function getFixtureSamplesDir(): string {
  return SAMPLES_DIR;
}

export async function loadFixtureIndex(samplesDir = SAMPLES_DIR): Promise<ParsedFixtureIndex> {
  const workDir = samplesDir;
  const files = fs.readdirSync(workDir).filter((f) => f.endsWith('.ts'));
  const parsed = await Promise.all(
    files.map((name) => parseOneFile(path.join(workDir, name), workDir)),
  );

  const fileEntries: FileEntry[] = [];
  const symbols: SymbolEntry[] = [];
  const imports: CodeMapCodeIndex['imports'] = [];
  const callEdges: CodeMapCodeIndex['callEdges'] = [];

  for (const row of parsed) {
    if (!row) continue;
    fileEntries.push(row.fileEntry);
    symbols.push(...row.symbols);
    imports.push(...row.imports);
    callEdges.push(...row.calls);
  }

  const codeIndex: CodeMapCodeIndex = {
    indexId: 'fixture_bench',
    files: fileEntries,
    symbols,
    chunks: parsed.flatMap((r) => r?.chunks ?? []),
    imports,
    callEdges,
    stats: {
      fileCount: fileEntries.length,
      symbolCount: symbols.length,
      chunkCount: parsed.reduce((n, r) => n + (r?.chunks.length ?? 0), 0),
      importCount: imports.length,
      callEdgeCount: callEdges.length,
    },
    updatedAt: Date.now(),
  };

  return {
    workDir,
    codeIndex,
    contexts: buildSymbolContexts(codeIndex),
  };
}

export function buildSymbolContexts(index: CodeMapCodeIndex): SymbolContext[] {
  const fileById = new Map(index.files.map((f) => [f.id, f]));
  const symbolById = new Map(index.symbols.map((s) => [s.id, s]));

  const calleesBySymbol = new Map<string, Set<string>>();
  const callersBySymbol = new Map<string, Set<string>>();
  for (const edge of index.callEdges) {
    if (!calleesBySymbol.has(edge.sourceSymbolId)) calleesBySymbol.set(edge.sourceSymbolId, new Set());
    calleesBySymbol.get(edge.sourceSymbolId)!.add(edge.targetName);

    const target = index.symbols.find((s) => s.name === edge.targetName);
    if (target) {
      if (!callersBySymbol.has(target.id)) callersBySymbol.set(target.id, new Set());
      callersBySymbol.get(target.id)!.add(symbolById.get(edge.sourceSymbolId)?.name ?? edge.sourceSymbolId);
    }
  }

  const importsByFile = new Map<string, string[]>();
  for (const imp of index.imports) {
    const list = importsByFile.get(imp.sourceFileId) ?? [];
    list.push(imp.targetModule);
    importsByFile.set(imp.sourceFileId, list);
  }

  return index.symbols
    .map((symbol) => {
      const file = fileById.get(symbol.fileId);
      if (!file) return null;
      return {
        symbol,
        file,
        callees: [...(calleesBySymbol.get(symbol.id) ?? [])],
        callers: [...(callersBySymbol.get(symbol.id) ?? [])],
        imports: importsByFile.get(symbol.fileId) ?? [],
      } satisfies SymbolContext;
    })
    .filter((ctx): ctx is SymbolContext => ctx !== null);
}

/** 自然语言 query → 期望命中的 symbol，用于 retrieval 基准（来自 eval-set.json） */
export function defaultRetrievalTasks(index: CodeMapCodeIndex): RetrievalTask[] {
  return loadEvalTasks(index);
}
