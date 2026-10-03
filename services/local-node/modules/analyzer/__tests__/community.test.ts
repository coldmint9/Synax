import { describe, it, expect } from 'vitest'
import type { FileEntry, SymbolEntry } from '../../contracts/forest.js'
import type { CodeMapCodeIndex, CodeMapImport } from '../../contracts/code-map.js'
import { buildAnalyzerGraph } from '../graph.js'
import { detectCommunities } from '../community.js'

// Budget mirrors the constants in community.ts (kept in sync intentionally).
const MAX_FILES = 20
const MAX_SYMBOLS = 80

function file(id: string, p: string): FileEntry {
  return { id, path: p, language: 'typescript', size: 100, sha: id }
}

function sym(id: string, fileId: string, name: string): SymbolEntry {
  return { id, fileId, kind: 'function', name, qualifiedName: name, range: { startLine: 1, endLine: 2 } }
}

function imp(sourceFileId: string, targetModule: string): CodeMapImport {
  return { sourceFileId, targetModule, line: 1, level: 0, isExternal: false }
}

function makeIndex(files: FileEntry[], symbols: SymbolEntry[], imports: CodeMapImport[]): CodeMapCodeIndex {
  return {
    indexId: 'test',
    files,
    symbols,
    chunks: [],
    imports,
    callEdges: [],
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      chunkCount: 0,
      importCount: imports.length,
      callEdgeCount: 0,
    },
    updatedAt: 0,
  }
}

function run(index: CodeMapCodeIndex) {
  return detectCommunities(index, buildAnalyzerGraph(index))
}

describe('detectCommunities — size-bounded agglomeration', () => {
  it('does not collapse a hub-and-spoke star into one giant community', () => {
    const files: FileEntry[] = [file('f_hub', 'src/types.ts')]
    const symbols: SymbolEntry[] = [sym('s_hub_1', 'f_hub', 'TypeA'), sym('s_hub_2', 'f_hub', 'TypeB')]
    const imports: CodeMapImport[] = []
    for (let i = 0; i < 50; i += 1) {
      const id = `f_${i}`
      files.push(file(id, `src/m${i}.ts`))
      symbols.push(sym(`${id}_1`, id, `fn${i}a`), sym(`${id}_2`, id, `fn${i}b`))
      imports.push(imp(id, './types')) // every spoke imports the shared hub
    }

    const { communities } = run(makeIndex(files, symbols, imports))

    // Core regression: a star must not become a single 51-file monster.
    expect(communities.length).toBeGreaterThan(1)
    for (const community of communities) {
      expect(community.fileCount).toBeLessThanOrEqual(MAX_FILES)
      expect(community.symbolCount).toBeLessThanOrEqual(MAX_SYMBOLS)
    }
    // Every file is assigned exactly once.
    const assigned = communities.flatMap((c) => c.fileIds)
    expect(new Set(assigned).size).toBe(files.length)
  })

  it('keeps two disconnected cohesive clusters separate', () => {
    const files = [
      file('a1', 'src/a/a1.ts'),
      file('a2', 'src/a/a2.ts'),
      file('a3', 'src/a/a3.ts'),
      file('b1', 'src/b/b1.ts'),
      file('b2', 'src/b/b2.ts'),
      file('b3', 'src/b/b3.ts'),
    ]
    const symbols = files.map((f) => sym(`${f.id}_s`, f.id, `${f.id}Fn`))
    const imports = [
      imp('a1', './a2'), imp('a2', './a3'), imp('a3', './a1'),
      imp('b1', './b2'), imp('b2', './b3'), imp('b3', './b1'),
    ]

    const { communities } = run(makeIndex(files, symbols, imports))

    expect(communities.length).toBe(2)
    const groups = communities.map((c) => [...c.fileIds].sort()).sort((x, y) => x[0].localeCompare(y[0]))
    expect(groups).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ])
  })

  it('is deterministic across runs', () => {
    const files: FileEntry[] = []
    const symbols: SymbolEntry[] = []
    const imports: CodeMapImport[] = []
    for (let i = 0; i < 30; i += 1) {
      const id = `f_${i}`
      files.push(file(id, `src/g${i % 5}/m${i}.ts`))
      symbols.push(sym(`${id}_s`, id, `fn${i}`))
      if (i % 5 !== 0) imports.push(imp(id, `./m${i - 1}`))
    }
    const index = makeIndex(files, symbols, imports)

    const first = run(index).communities.map((c) => [...c.fileIds].sort().join(','))
    const second = run(index).communities.map((c) => [...c.fileIds].sort().join(','))
    expect(second).toEqual(first)
  })

  it('isolates a large file that alone exceeds the symbol budget', () => {
    const files = [file('big', 'src/gen/types.gen.ts'), file('small', 'src/gen/util.ts')]
    const symbols: SymbolEntry[] = []
    for (let i = 0; i < MAX_SYMBOLS + 20; i += 1) symbols.push(sym(`big_${i}`, 'big', `T${i}`))
    symbols.push(sym('small_1', 'small', 'helper'))
    // No imports — both are isolated leftovers in the same folder.

    const { communities } = run(makeIndex(files, symbols, []))

    for (const community of communities) {
      // The big file cannot be packed with anything without breaking the budget.
      if (community.fileIds.includes('big')) {
        expect(community.fileIds).toEqual(['big'])
      }
      expect(community.symbolCount).toBeLessThanOrEqual(MAX_SYMBOLS + 20)
    }
    const assigned = communities.flatMap((c) => c.fileIds)
    expect(new Set(assigned)).toEqual(new Set(['big', 'small']))
  })
})
