import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ChunkEntry,
  CoordEdge,
  CoordForest,
  CoordNode,
  FileEntry,
  SourceBinding,
  SourceLink,
  SourceLinkAnchor,
  SymbolEntry,
} from '../contracts/forest.js'
import type {
  CodeMapCodeIndex,
  CodeMapImport,
} from '../contracts/code-map.js'

export type ParserLanguageKey =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'php'
  | 'ruby'
  | 'kotlin'
  | 'swift'

export interface AnalyzerSourceFile {
  entry: FileEntry
  relPath: string
  absPath: string
  text: string
  language: string
  parserLanguage: ParserLanguageKey | null
}

export interface AnalyzerParseResult {
  codeIndex: CodeMapCodeIndex
  files: AnalyzerSourceFile[]
  warnings: string[]
}

export const FILE_READ_LIMIT = 512 * 1024
export const MAX_SCAN_FILES = 1000
export const MAX_PREVIEW = 220
export const COMMUNITY_EDGE_WEIGHT = 1

// Only source-like files should participate in tree-setter and community analysis.
const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, { language: string; parserLanguage?: ParserLanguageKey }> = {
  '.ts': { language: 'typescript', parserLanguage: 'typescript' },
  '.tsx': { language: 'typescript', parserLanguage: 'tsx' },
  '.js': { language: 'javascript', parserLanguage: 'javascript' },
  '.jsx': { language: 'javascript', parserLanguage: 'jsx' },
  '.mjs': { language: 'javascript', parserLanguage: 'javascript' },
  '.cjs': { language: 'javascript', parserLanguage: 'javascript' },
  '.py': { language: 'python', parserLanguage: 'python' },
  '.java': { language: 'java', parserLanguage: 'java' },
  '.c': { language: 'c', parserLanguage: 'c' },
  '.h': { language: 'c', parserLanguage: 'c' },
  '.cc': { language: 'cpp', parserLanguage: 'cpp' },
  '.cpp': { language: 'cpp', parserLanguage: 'cpp' },
  '.cxx': { language: 'cpp', parserLanguage: 'cpp' },
  '.hh': { language: 'cpp', parserLanguage: 'cpp' },
  '.hpp': { language: 'cpp', parserLanguage: 'cpp' },
  '.hxx': { language: 'cpp', parserLanguage: 'cpp' },
  '.cs': { language: 'csharp', parserLanguage: 'csharp' },
  '.go': { language: 'go', parserLanguage: 'go' },
  '.rs': { language: 'rust', parserLanguage: 'rust' },
  '.php': { language: 'php', parserLanguage: 'php' },
  '.rb': { language: 'ruby', parserLanguage: 'ruby' },
  '.kt': { language: 'kotlin', parserLanguage: 'kotlin' },
  '.kts': { language: 'kotlin', parserLanguage: 'kotlin' },
  '.swift': { language: 'swift', parserLanguage: 'swift' },
  '.sql': { language: 'sql' },
  '.sh': { language: 'shell' },
}

export const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.vs',
  '.settings',
  '.metadata',
  '.history',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'target',
  'release',
  'debug',
  'coverage',
  'htmlcov',
  'reports',
  'test-results',
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.docusaurus',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.cache',
  '.yarn',
  '.pnpm-store',
  '.storybook-out',
  'storybook-static',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  'site-packages',
  '.eggs',
  '.gradle',
  '.mvn',
  'classes',
  'generated-sources',
  'tmp',
  'temp',
  'logs',
])

const IGNORED_FILE_PATTERNS = [/\.min\.[cm]?js$/i, /\.bundle\.js$/i, /\.map$/i, /\.py[co]$/i]

export function now(): number {
  return Date.now()
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

export function hashParts(...parts: string[]): string {
  return hashText(parts.join('\0'))
}

export function compact(text: string, max = MAX_PREVIEW): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trim()}…`
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.7
  return Math.max(0, Math.min(1, value))
}

export function normalizeIntent(intent: string): string {
  return intent.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function scoreText(haystack: string, needle: string): number {
  const h = haystack.toLowerCase()
  const n = normalizeIntent(needle)
  if (!n) return 0
  if (h === n) return 1
  let score = 0
  for (const token of n.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (h.includes(token)) score += 1
  }
  if (h.includes(n)) score += 2
  return score
}

export function topSentences(text: string, limit = 3): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => compact(part, 180))
    .filter(Boolean)
    .slice(0, limit)
}

export function topDirFromPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return '.'
  if (parts[0] === 'web' && parts[1] === 'src') return 'web'
  return parts[0]
}

export function fileBaseLabel(relPath: string): string {
  const base = path.basename(relPath)
  return base.replace(path.extname(base), '') || relPath
}

export function makeFileId(relPath: string): string {
  return `file_${hashParts(relPath)}`
}

export function makeSymbolId(fileId: string, name: string, line: number): string {
  return `sym_${hashParts(fileId, name, String(line))}`
}

export function makeChunkId(fileId: string, startLine: number, endLine: number): string {
  return `chunk_${hashParts(fileId, String(startLine), String(endLine))}`
}

export function makeNodeId(kind: 'feature' | 'goal' | 'action', label: string, seed: string): string {
  return `${kind}_${hashParts(kind, label, seed)}`
}

export function makeLinkId(nodeId: string, anchor: SourceLinkAnchor): string {
  return `link_${hashParts(nodeId, JSON.stringify(anchor))}`
}

export function detectLanguage(absPath: string): string {
  const info = SOURCE_LANGUAGE_BY_EXTENSION[path.extname(absPath).toLowerCase()]
  return info?.language ?? (path.extname(absPath).replace(/^\./, '') || 'text')
}

export function detectParserLanguage(absPath: string): ParserLanguageKey | null {
  return SOURCE_LANGUAGE_BY_EXTENSION[path.extname(absPath).toLowerCase()]?.parserLanguage ?? null
}

export function shouldScanFile(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase()
  if (!SOURCE_LANGUAGE_BY_EXTENSION[ext]) return false
  const base = path.basename(absPath)
  return !IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(base))
}

export function readTextFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile() || stat.size > FILE_READ_LIMIT) return null
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

function walkRepositoryFilesGit(rootPath: string, limit: number): string[] | null {
  try {
    const result = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const files: string[] = []
    for (const line of result.split('\n')) {
      if (!line) continue
      const absPath = path.resolve(rootPath, line)
      if (shouldScanFile(absPath)) {
        files.push(absPath)
        if (files.length >= limit) break
      }
    }
    return files
  } catch {
    return null
  }
}

function walkRepositoryFilesFallback(rootPath: string, limit: number): string[] {
  const out: string[] = []
  const visit = (current: string) => {
    if (out.length >= limit) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(current)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      const base = path.basename(current)
      if (IGNORED_DIR_NAMES.has(base)) return
      const children = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of children) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue
        visit(path.join(current, entry.name))
        if (out.length >= limit) break
      }
      return
    }
    if (stat.isFile() && shouldScanFile(current)) {
      out.push(current)
    }
  }
  visit(rootPath)
  return out
}

export function walkRepositoryFiles(rootPath: string, limit = MAX_SCAN_FILES): string[] {
  return walkRepositoryFilesGit(rootPath, limit) ?? walkRepositoryFilesFallback(rootPath, limit)
}

export function chunkForSymbol(fileId: string, symbol: SymbolEntry): ChunkEntry {
  return {
    id: makeChunkId(fileId, symbol.range.startLine, symbol.range.endLine),
    fileId,
    symbolIds: [symbol.id],
    range: { startLine: symbol.range.startLine, endLine: symbol.range.endLine },
    hash: hashParts(fileId, symbol.id, String(symbol.range.startLine), String(symbol.range.endLine)),
  }
}

export function chunkForFile(fileId: string, text: string): ChunkEntry {
  const lines = text.split(/\r?\n/)
  return {
    id: makeChunkId(fileId, 1, lines.length),
    fileId,
    symbolIds: [],
    range: { startLine: 1, endLine: lines.length },
    hash: hashParts(fileId, text.slice(0, 16_000)),
  }
}

export function createEmptySourceBinding(): SourceBinding {
  return { kind: 'scratch' }
}

export function createEmptyCodeIndex(): CodeMapCodeIndex {
  return {
    indexId: '',
    files: [],
    symbols: [],
    chunks: [],
    imports: [],
    stats: { fileCount: 0, symbolCount: 0, chunkCount: 0, importCount: 0 },
    updatedAt: 0,
  }
}

export function createForestBase(projectId: string, label: string, source?: SourceBinding | null): CoordForest {
  const started = now()
  const rootId = `project-${projectId}`
  return {
    projectId,
    schemaVersion: 3,
    revision: 0,
    rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        type: 'project',
        label,
        summary: 'Project root generated from local analyzer scan.',
        status: 'active',
        progress: 0,
        parentId: null,
        children: [],
        origin: 'analyzed',
        createdAt: started,
        updatedAt: started,
      },
    },
    edges: [],
    source: source ?? createEmptySourceBinding(),
    codeIndex: createEmptyCodeIndex(),
    semanticGraph: { nodes: [], edges: [] },
    links: [],
    analysis: { phase: 'idle', progress: 0 },
    lifecycle: { initState: 'idle', autoSync: false },
    meta: {
      label,
      createdAt: started,
      updatedAt: started,
      tokens: {},
    },
  }
}

export function projectLabelFromPath(workDirAbs: string, projectId: string): string {
  const tail = path.basename(workDirAbs.replace(/[\\/]+$/, ''))
  return tail || projectId
}

export function sourceRevisionForScan(source: SourceBinding | null | undefined, files: FileEntry[]): string | null {
  if (source?.commitSha) return source.commitSha
  if (!files.length) return null
  const hash = crypto.createHash('sha1')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.sha)
    hash.update('\0')
  }
  return `tree:${hash.digest('hex').slice(0, 16)}`
}

export function createActionNode(
  actionId: string,
  goalId: string,
  file: FileEntry,
  createdAt: number,
): CoordNode {
  return {
    id: actionId,
    type: 'action',
    label: fileBaseLabel(file.path),
    summary: `${file.language} file ${file.path}`,
    status: 'draft',
    progress: 0.25,
    executor: { type: 'agent', name: 'analyzer', provider: 'local' },
    parentId: goalId,
    children: [],
    createdAt,
    updatedAt: createdAt,
    origin: 'analyzed',
    tags: [file.language, topDirFromPath(file.path)],
  }
}

export function attachChildren(nodes: Map<string, CoordNode>): void {
  const byParent = new Map<string, string[]>()
  for (const node of nodes.values()) {
    if (!node.parentId) continue
    const bucket = byParent.get(node.parentId) ?? []
    bucket.push(node.id)
    byParent.set(node.parentId, bucket)
  }
  for (const node of nodes.values()) {
    node.children = byParent.get(node.id) ?? []
  }
}

export function createHierarchyEdge(source: string, target: string, strength: number): CoordEdge {
  return {
    id: `edge_${hashParts(source, target, 'hierarchy')}`,
    source,
    target,
    strength,
    type: 'hierarchy',
    origin: 'analyzed',
  }
}

export function createSourceLinks(nodeId: string, file: FileEntry, symbolIds: string[] = []): SourceLink[] {
  const links: SourceLink[] = [
    {
      id: makeLinkId(nodeId, { kind: 'file', fileId: file.id }),
      nodeId,
      anchor: { kind: 'file', fileId: file.id },
      confidence: 0.8,
      createdBy: 'analyzer',
    },
  ]
  for (const symbolId of symbolIds.slice(0, 3)) {
    links.push({
      id: makeLinkId(nodeId, { kind: 'symbol', symbolId }),
      nodeId,
      anchor: { kind: 'symbol', symbolId },
      confidence: 0.7,
      createdBy: 'analyzer',
    })
  }
  return links
}

export function importCountByFile(imports: CodeMapImport[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of imports) {
    counts.set(entry.sourceFileId, (counts.get(entry.sourceFileId) ?? 0) + 1)
  }
  return counts
}
