import path from 'node:path'
import type { CodeMapCodeIndex, CodeMapImport } from '../contracts/code-map.js'
import { topDirFromPath } from './shared.js'

export interface ResolvedImportEdge {
  sourceFileId: string
  targetFileId: string
  sourcePath: string
  targetPath: string
  targetModule: string
  weight: number
}

export interface AnalyzerGraph {
  resolvedImports: ResolvedImportEdge[]
  fileNeighbors: Map<string, Map<string, number>>
  fileDegree: Map<string, number>
  symbolIdsByFile: Map<string, string[]>
  fileToPath: Map<string, string>
  fileToDir: Map<string, string>
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const C_EXTENSIONS = ['.h', '.hpp', '.hh', '.hxx', '.c', '.cc', '.cpp', '.cxx']
const DOTTED_LANGUAGE_EXTENSIONS = ['.java', '.cs', '.go', '.kt', '.kts', '.swift', '.rb', '.php']

export function buildAnalyzerGraph(codeIndex: CodeMapCodeIndex): AnalyzerGraph {
  const lookup = new Map(codeIndex.files.map((file) => [file.path, file.id] as const))
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))
  const fileNeighbors = new Map<string, Map<string, number>>()
  const symbolIdsByFile = new Map<string, string[]>()

  for (const symbol of codeIndex.symbols) {
    const bucket = symbolIdsByFile.get(symbol.fileId) ?? []
    bucket.push(symbol.id)
    symbolIdsByFile.set(symbol.fileId, bucket)
  }

  const resolvedImports: ResolvedImportEdge[] = []
  for (const entry of codeIndex.imports) {
    if (entry.isExternal) continue
    const sourceFile = fileById.get(entry.sourceFileId)
    if (!sourceFile) continue
    const targetFileId = resolveImport(entry, sourceFile.path, lookup)
    if (!targetFileId || targetFileId === sourceFile.id) continue
    const targetFile = fileById.get(targetFileId)
    if (!targetFile) continue
    resolvedImports.push({
      sourceFileId: sourceFile.id,
      targetFileId,
      sourcePath: sourceFile.path,
      targetPath: targetFile.path,
      targetModule: entry.targetModule,
      weight: 1,
    })
    incrementWeight(fileNeighbors, sourceFile.id, targetFileId, 1)
    incrementWeight(fileNeighbors, targetFileId, sourceFile.id, 1)
  }

  const byDir = new Map<string, string[]>()
  for (const file of codeIndex.files) {
    const dir = topDirFromPath(file.path)
    const bucket = byDir.get(dir) ?? []
    bucket.push(file.id)
    byDir.set(dir, bucket)
  }

  for (const fileIds of byDir.values()) {
    if (fileIds.length < 2) continue
    const isolated = fileIds.filter((fileId) => !fileNeighbors.get(fileId)?.size)
    if (isolated.length < 2) continue
    for (let index = 1; index < isolated.length; index += 1) {
      incrementWeight(fileNeighbors, isolated[0], isolated[index], 0.15)
      incrementWeight(fileNeighbors, isolated[index], isolated[0], 0.15)
    }
  }

  const fileDegree = new Map<string, number>()
  for (const file of codeIndex.files) {
    const degree = [...(fileNeighbors.get(file.id)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0)
    fileDegree.set(file.id, degree)
  }

  return {
    resolvedImports,
    fileNeighbors,
    fileDegree,
    symbolIdsByFile,
    fileToPath: new Map(codeIndex.files.map((file) => [file.id, file.path] as const)),
    fileToDir: new Map(codeIndex.files.map((file) => [file.id, topDirFromPath(file.path)] as const)),
  }
}

function resolveImport(entry: CodeMapImport, sourcePath: string, lookup: Map<string, string>): string | null {
  const ext = path.extname(sourcePath).toLowerCase()
  if (entry.level > 0 || sourcePath.endsWith('.py')) {
    return resolvePythonImport(sourcePath, entry.targetModule, entry.level, lookup)
  }
  if (TS_EXTENSIONS.includes(ext)) {
    return resolveTsImport(sourcePath, entry.targetModule, lookup)
  }
  if (C_EXTENSIONS.includes(ext)) {
    return resolveCImport(sourcePath, entry.targetModule, lookup)
  }
  if (sourcePath.endsWith('.rs')) {
    return resolveDottedImport(entry.targetModule.replace(/::/g, '/'), lookup, ['.rs'])
  }
  if (sourcePath.endsWith('.rb')) {
    return resolveRubyImport(sourcePath, entry, lookup)
  }
  if (sourcePath.endsWith('.php')) {
    return resolveDottedImport(entry.targetModule.replace(/\\/g, '/'), lookup, ['.php'])
  }
  if (DOTTED_LANGUAGE_EXTENSIONS.includes(ext)) {
    return resolveDottedImport(entry.targetModule, lookup, [ext])
  }
  return null
}

function resolveTsImport(sourcePath: string, targetModule: string, lookup: Map<string, string>): string | null {
  if (!targetModule.startsWith('.') && !targetModule.startsWith('/')) return null
  const sourceDir = path.posix.dirname(sourcePath)
  const base = normalizePosix(sourceDir === '.' ? targetModule : `${sourceDir}/${targetModule}`)
  const candidates = [base, ...TS_EXTENSIONS.map((ext) => `${base}${ext}`), ...TS_EXTENSIONS.map((ext) => `${base}/index${ext}`)]
  return findFirstLookup(lookup, candidates)
}

function resolvePythonImport(sourcePath: string, targetModule: string, level: number, lookup: Map<string, string>): string | null {
  if (level > 0) {
    let anchor = path.posix.dirname(sourcePath)
    for (let index = 1; index < level; index += 1) {
      anchor = path.posix.dirname(anchor)
    }
    const normalizedTarget = targetModule.replace(/\./g, '/')
    const base = normalizePosix(normalizedTarget ? `${anchor}/${normalizedTarget}` : anchor)
    return findFirstLookup(lookup, [`${base}.py`, `${base}/__init__.py`])
  }
  const base = normalizePosix(targetModule.replace(/\./g, '/'))
  return findFirstLookup(lookup, [`${base}.py`, `${base}/__init__.py`])
}

function resolveCImport(sourcePath: string, targetModule: string, lookup: Map<string, string>): string | null {
  const sourceDir = path.posix.dirname(sourcePath)
  const raw = targetModule.replace(/^["<]/, '').replace(/[">]$/, '')
  const candidates = [normalizePosix(`${sourceDir}/${raw}`), normalizePosix(raw)]
  const stem = raw.replace(/\.[^.]+$/, '')
  for (const ext of C_EXTENSIONS) {
    candidates.push(normalizePosix(`${sourceDir}/${stem}${ext}`))
    candidates.push(normalizePosix(`${stem}${ext}`))
  }
  return findFirstLookup(lookup, candidates)
}

function resolveDottedImport(targetModule: string, lookup: Map<string, string>, extensions: string[]): string | null {
  const base = normalizePosix(targetModule.replace(/::/g, '/').replace(/\./g, '/').replace(/\\/g, '/'))
  const tail = base.split('/').filter(Boolean).at(-1) ?? ''
  const candidates = [base]
  for (const ext of extensions) {
    candidates.push(`${base}${ext}`)
    if (tail) candidates.push(`${base}/${tail}${ext}`)
  }
  return findFirstLookup(lookup, candidates)
}

function resolveRubyImport(sourcePath: string, entry: CodeMapImport, lookup: Map<string, string>): string | null {
  if (entry.level > 0) {
    const sourceDir = path.posix.dirname(sourcePath)
    const base = normalizePosix(`${sourceDir}/${entry.targetModule}`)
    return findFirstLookup(lookup, [`${base}.rb`, base])
  }
  return resolveDottedImport(entry.targetModule, lookup, ['.rb'])
}

function findFirstLookup(lookup: Map<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const match = lookup.get(candidate)
    if (match) return match
  }
  return null
}

function normalizePosix(value: string): string {
  const parts: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

function incrementWeight(map: Map<string, Map<string, number>>, source: string, target: string, weight: number): void {
  const bucket = map.get(source) ?? new Map<string, number>()
  bucket.set(target, (bucket.get(target) ?? 0) + weight)
  map.set(source, bucket)
}
