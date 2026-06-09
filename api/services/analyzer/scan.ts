import type {
  AnalysisReport,
  CoordEdge,
  CoordForest,
  CoordNode,
  FileEntry,
  SourceBinding,
  SourceLink,
} from '../contracts/forest.js'
import type {
  CodeMapCodeIndex,
  CodeMapCommunity,
  CodeMapCoordSeed,
  CodeMapDependencySummary,
  CodeMapFileSummary,
  CodeMapModuleMap,
  CodeMapModuleSummary,
  CodeMapScanRequest,
  CodeMapScanResult,
  CodeMapSymbolSummary,
} from '../contracts/code-map.js'
import type { HybridResult, MountHint, SearchHit, SearchMode } from '../contracts/search.js'
import type { AnalyzerGraph } from './graph.js'
import { buildAnalyzerGraph } from './graph.js'
import { detectCommunities } from './community.js'
import {
  attachChildren,
  createActionNode,
  createForestBase,
  createHierarchyEdge,
  createSourceLinks,
  hashParts,
  importCountByFile,
  makeNodeId,
  normalizeIntent,
  now,
  projectLabelFromPath,
  scoreText,
  topDirFromPath,
} from './shared.js'
import { parseRepository } from './parser.js'
import { contextService } from '../context/context-service.js'
import { searchService } from '../context/search-service.js'
import { resolveWorkspacePath, workspaceRoot } from '../agent-runtime/tools/workspace.js'
import { logger } from '../../lib/logger.js'

export interface ScanDiffEntry {
  kind:
    | 'file_added'
    | 'file_removed'
    | 'file_modified'
    | 'symbol_added'
    | 'symbol_removed'
    | 'symbol_modified'
    | 'community_shifted'
  entityId: string
  path?: string
  oldValue?: Record<string, unknown>
  newValue?: Record<string, unknown>
  significance: number
}

export interface ScanDiff {
  projectId: string
  oldScanId: string
  newScanId: string
  oldSourceRevision?: string
  newSourceRevision?: string
  entries: ScanDiffEntry[]
  summary: string
  stats: Record<string, number>
}

export interface NormalizedScanRequest {
  workDirAbs: string
  source: SourceBinding | null
  warnings: string[]
}

export async function normalizeScanRequest(req: CodeMapScanRequest): Promise<NormalizedScanRequest> {
  const warnings: string[] = []
  const source = req.source ?? null
  let workDir = req.workDir ?? source?.localPath ?? ''
  if (!workDir) {
    workDir = workspaceRoot()
    warnings.push('workDir missing; defaulted to workspace root')
  }
  let workDirAbs: string
  try {
    workDirAbs = resolveWorkspacePath(workDir)
  } catch {
    workDirAbs = workDir
    warnings.push('workDir resolved outside workspace guard; scanning direct path')
  }
  if (source?.kind === 'git' && !source.commitSha) warnings.push('git source missing commitSha; using content hash revision')
  return { workDirAbs, source, warnings }
}

export async function runCodeMapScan(req: CodeMapScanRequest): Promise<CodeMapScanResult> {
  const normalized = await normalizeScanRequest(req)
  const started = now()

  logger.info('[analyzer] ▶ scan started', { workDir: normalized.workDirAbs })
  const parsed = await parseRepository(normalized.workDirAbs)

  logger.info(`[analyzer] ███████░░░ 70% — building dependency graph...`)
  const graph = buildAnalyzerGraph(parsed.codeIndex)

  logger.info(`[analyzer] ████████░░ 80% — detecting communities...`)
  const communityResult = detectCommunities(parsed.codeIndex, graph)

  logger.info(`[analyzer] █████████░ 90% — building module map...`)
  const moduleMap = buildModuleMap(parsed.codeIndex, graph)

  logger.info(`[analyzer] █████████▓ 95% — generating coordinate seed...`)
  const coordSeed = buildCoordSeed(req.projectId, parsed.codeIndex, moduleMap, communityResult.communities, graph)

  const result: CodeMapScanResult = {
    projectId: req.projectId,
    scanId: `scan_${hashParts(req.projectId, String(started), String(parsed.codeIndex.files.length), String(parsed.codeIndex.symbols.length))}`,
    generatedAt: started,
    durationMs: Math.max(1, now() - started),
    workDir: normalized.workDirAbs,
    source: normalized.source,
    codeIndex: parsed.codeIndex,
    semanticGraph: communityResult.semanticGraph,
    moduleMap,
    communities: communityResult.communities,
    coordSeed,
    warnings: [...normalized.warnings, ...parsed.warnings],
  }

  logger.info(`[analyzer] ██████████ 100% — scan complete`, {
    files: parsed.codeIndex.files.length,
    symbols: parsed.codeIndex.symbols.length,
    communities: communityResult.communities.length,
    durationMs: result.durationMs,
  })

  return result
}

export function buildModuleMap(codeIndex: CodeMapCodeIndex, graph: AnalyzerGraph): CodeMapModuleMap {
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))
  const importsBySource = importCountByFile(codeIndex.imports)
  const dirStats = new Map<string, { fileIds: string[]; languages: Record<string, number>; importsIn: number; importsOut: number; symbolCount: number }>()
  const degreeBySymbol = new Map<string, number>()
  const dependenciesByKey = new Map<string, CodeMapDependencySummary>()

  for (const symbol of codeIndex.symbols) {
    degreeBySymbol.set(symbol.id, graph.fileDegree.get(symbol.fileId) ?? 0)
  }

  for (const file of codeIndex.files) {
    const dir = topDirFromPath(file.path)
    const bucket = dirStats.get(dir) ?? { fileIds: [], languages: {}, importsIn: 0, importsOut: 0, symbolCount: 0 }
    bucket.fileIds.push(file.id)
    bucket.languages[file.language] = (bucket.languages[file.language] ?? 0) + 1
    bucket.symbolCount += graph.symbolIdsByFile.get(file.id)?.length ?? 0
    bucket.importsOut += importsBySource.get(file.id) ?? 0
    dirStats.set(dir, bucket)
  }

  for (const edge of graph.resolvedImports) {
    const sourceDir = topDirFromPath(edge.sourcePath)
    const targetDir = topDirFromPath(edge.targetPath)
    if (sourceDir === targetDir) continue
    const targetBucket = dirStats.get(targetDir)
    if (targetBucket) targetBucket.importsIn += 1
    const key = `${sourceDir}->${targetDir}`
    const existing = dependenciesByKey.get(key)
    if (existing) {
      existing.weight += 1
      continue
    }
    dependenciesByKey.set(key, {
      source: sourceDir,
      target: targetDir,
      kind: 'imports',
      weight: 1,
    })
  }

  const topDirs: CodeMapModuleSummary[] = [...dirStats.entries()]
    .map(([dir, bucket]) => ({
      path: dir,
      fileCount: bucket.fileIds.length,
      symbolCount: bucket.symbolCount,
      languages: bucket.languages,
      importsIn: bucket.importsIn,
      importsOut: bucket.importsOut,
      score: bucket.fileIds.length * 2 + bucket.symbolCount + bucket.importsIn * 0.5 + bucket.importsOut * 0.5,
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 32)

  const languages = Object.entries(
    codeIndex.files.reduce<Record<string, { fileCount: number; symbolCount: number; bytes: number }>>((acc, file) => {
      const bucket = acc[file.language] ?? { fileCount: 0, symbolCount: 0, bytes: 0 }
      bucket.fileCount += 1
      bucket.symbolCount += graph.symbolIdsByFile.get(file.id)?.length ?? 0
      bucket.bytes += file.size
      acc[file.language] = bucket
      return acc
    }, {}),
  ).map(([language, bucket]) => ({
    language,
    fileCount: bucket.fileCount,
    symbolCount: bucket.symbolCount,
    bytes: bucket.bytes,
  })).sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language))

  const entryFiles: CodeMapFileSummary[] = codeIndex.files
    .map((file) => ({
      fileId: file.id,
      path: file.path,
      language: file.language,
      symbolCount: graph.symbolIdsByFile.get(file.id)?.length ?? 0,
      importCount: importsBySource.get(file.id) ?? 0,
      score: scoreEntryFile(file, importsBySource.get(file.id) ?? 0, graph.symbolIdsByFile.get(file.id)?.length ?? 0),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 48)

  const coreSymbols: CodeMapSymbolSummary[] = codeIndex.symbols
    .map((symbol) => ({
      id: symbol.id,
      fileId: symbol.fileId,
      path: fileById.get(symbol.fileId)?.path ?? symbol.fileId,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      degree: Math.round((degreeBySymbol.get(symbol.id) ?? 0) * 10) / 10,
      centrality: Math.min(1, (degreeBySymbol.get(symbol.id) ?? 0) / 6),
    }))
    .sort((left, right) => right.degree - left.degree || left.path.localeCompare(right.path) || left.name.localeCompare(right.name))
    .slice(0, 64)

  return {
    topDirs,
    languages,
    entryFiles,
    coreSymbols,
    dependencies: [...dependenciesByKey.values()].sort((left, right) => right.weight - left.weight || left.source.localeCompare(right.source)).slice(0, 120),
  }
}

export function buildCoordSeed(
  projectId: string,
  codeIndex: CodeMapCodeIndex,
  _moduleMap: CodeMapModuleMap,
  communities: CodeMapCommunity[],
  graph: AnalyzerGraph,
): CodeMapCoordSeed {
  const started = now()
  const rootId = `project-${projectId}`
  const nodes: CoordNode[] = []
  const edges: CoordEdge[] = []
  const links: SourceLink[] = []
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))

  for (const community of communities.slice(0, 8)) {
    const featureId = makeNodeId('feature', community.label, projectId)
    const goalId = makeNodeId('goal', community.label, `${projectId}:goal`)
    nodes.push({
      id: featureId,
      type: 'feature',
      label: community.label,
      summary: community.summary,
      status: 'active',
      progress: Math.min(1, community.score / 12),
      parentId: rootId,
      children: [goalId],
      createdAt: started,
      updatedAt: started,
      origin: 'analyzed',
      tags: ['module'],
    })
    nodes.push({
      id: goalId,
      type: 'goal',
      label: `${community.label} roadmap`,
      summary: `Coordinate implementation for ${community.label}.`,
      status: 'active',
      progress: Math.min(1, community.fileCount / 10),
      parentId: featureId,
      children: [],
      createdAt: started,
      updatedAt: started,
      origin: 'analyzed',
      tags: ['goal', community.label],
    })
    edges.push(createHierarchyEdge(rootId, featureId, 1))
    edges.push(createHierarchyEdge(featureId, goalId, 0.9))

    const actionSources = community.fileIds
      .map((fileId) => fileById.get(fileId))
      .filter((file): file is FileEntry => Boolean(file))
      .sort((left, right) => (graph.fileDegree.get(right.id) ?? 0) - (graph.fileDegree.get(left.id) ?? 0))
      .slice(0, 3)
    for (const file of actionSources) {
      const actionId = makeNodeId('action', file.path, projectId)
      nodes.push(createActionNode(actionId, goalId, file, started))
      edges.push(createHierarchyEdge(goalId, actionId, 0.8))
      const symbolIdsForFile = codeIndex.symbols.filter((symbol) => symbol.fileId === file.id).map((symbol) => symbol.id)
      links.push(...createSourceLinks(actionId, file, symbolIdsForFile))
    }
  }

  return {
    rootId,
    nodes,
    edges,
    links,
    patch: {
      projectId,
      revision: 0,
      nodes: { upsert: nodes },
      edges: { upsert: edges },
      links: { upsert: links },
      analysis: { phase: 'mapping', progress: 80 },
      lifecycle: { initState: 'building', autoSync: false },
      meta: { updatedAt: started },
    },
  }
}

export function buildForestFromScan(scan: CodeMapScanResult): CoordForest {
  const label = projectLabelFromPath(scan.workDir, scan.projectId)
  const forest = createForestBase(scan.projectId, label, scan.source ?? null)
  forest.codeIndex = {
    indexId: scan.codeIndex.indexId,
    files: scan.codeIndex.files,
    symbols: scan.codeIndex.symbols,
    chunks: scan.codeIndex.chunks,
    stats: {
      fileCount: scan.codeIndex.stats.fileCount,
      symbolCount: scan.codeIndex.stats.symbolCount,
      chunkCount: scan.codeIndex.stats.chunkCount,
    },
    updatedAt: scan.codeIndex.updatedAt,
  }
  forest.semanticGraph = scan.semanticGraph

  const nodeMap = new Map<string, CoordNode>(Object.entries(forest.nodes))
  const edges: CoordEdge[] = []
  const links: SourceLink[] = []
  const createdAt = now()
  const fileById = new Map(scan.codeIndex.files.map((file) => [file.id, file] as const))

  for (const community of scan.communities?.slice(0, 8) ?? []) {
    const featureId = makeNodeId('feature', community.label, scan.projectId)
    const goalId = makeNodeId('goal', community.label, `${scan.projectId}:goal`)
    nodeMap.set(featureId, {
      id: featureId,
      type: 'feature',
      label: community.label,
      summary: community.summary,
      status: 'active',
      progress: Math.min(1, community.score / 12),
      parentId: forest.rootId,
      children: [goalId],
      createdAt,
      updatedAt: createdAt,
      origin: 'analyzed',
      tags: ['module'],
    })
    nodeMap.set(goalId, {
      id: goalId,
      type: 'goal',
      label: `${community.label} roadmap`,
      summary: `Coordinate implementation for ${community.label}.`,
      status: 'active',
      progress: Math.min(1, community.fileCount / 10),
      parentId: featureId,
      children: [],
      createdAt,
      updatedAt: createdAt,
      origin: 'analyzed',
      tags: ['goal', community.label],
    })
    edges.push(createHierarchyEdge(forest.rootId, featureId, 1))
    edges.push(createHierarchyEdge(featureId, goalId, 0.9))

    for (const fileId of community.fileIds.slice(0, 3)) {
      const file = fileById.get(fileId)
      if (!file) continue
      const actionId = makeNodeId('action', file.path, scan.projectId)
      nodeMap.set(actionId, createActionNode(actionId, goalId, file, createdAt))
      edges.push(createHierarchyEdge(goalId, actionId, 0.8))
      links.push(...createSourceLinks(actionId, file))
    }
  }

  attachChildren(nodeMap)
  const report: AnalysisReport = {
    featuresCreated: [...nodeMap.values()].filter((node) => node.type === 'feature').length,
    goalsCreated: [...nodeMap.values()].filter((node) => node.type === 'goal').length,
    actionsCreated: [...nodeMap.values()].filter((node) => node.type === 'action').length,
    linksCreated: links.length,
    message: `Local analyzer scanned ${scan.codeIndex.files.length} files.`,
    warnings: scan.warnings,
  }

  forest.nodes = Object.fromEntries(nodeMap.entries())
  forest.edges = edges
  forest.links = links
  forest.analysis = {
    lastRunId: scan.scanId,
    startedAt: scan.generatedAt,
    completedAt: scan.generatedAt + scan.durationMs,
    phase: 'ready',
    progress: 100,
    message: `Indexed ${scan.codeIndex.files.length} files across ${scan.communities?.length ?? 0} communities.`,
    report,
  }
  forest.lifecycle = { initState: 'ready', autoSync: false }
  forest.meta.updatedAt = now()
  forest.meta.tokens.analyzerToken = 'local'
  return forest
}

export function searchScan(req: { projectId: string; query: string; mode?: SearchMode; topK?: number }, scan: CodeMapScanResult | null): HybridResult {
  if (!scan) {
    const fallback = searchService.searchAll(req.projectId, req.query, { limit: req.topK ?? 20 })
    return {
      query: req.query,
      mode: req.mode ?? 'hybrid',
      hits: fallback.map((hit) => ({
        id: hit.id,
        kind: 'file',
        score: hit.score,
        filePath: 'context',
        range: { startLine: 1, endLine: 1 },
        preview: hit.snippet,
        symbolIds: [],
        provenance: req.mode === 'keyword' ? 'keyword' : 'hybrid',
      })),
    }
  }
  const q = normalizeIntent(req.query)
  const workDirAbs = scan.workDir
  const hits: SearchHit[] = []
  const fileById = new Map(scan.codeIndex.files.map((file) => [file.id, file] as const))
  for (const file of scan.codeIndex.files) {
    const previewPath = `${workDirAbs}/${file.path}`
    const previewText = previewPath
    const fileSymbols = scan.codeIndex.symbols.filter((symbol) => symbol.fileId === file.id)
    const score = scoreText(file.path, q) + fileSymbols.reduce((sum, symbol) => sum + scoreText(symbol.name, q) * 0.8, 0)
    if (score <= 0) continue
    hits.push({
      id: file.id,
      kind: 'file',
      score,
      filePath: file.path,
      range: { startLine: 1, endLine: 1 },
      preview: previewText,
      symbolIds: fileSymbols.map((symbol) => symbol.id).slice(0, 5),
      provenance: req.mode === 'keyword' ? 'keyword' : 'hybrid',
    })
  }
  for (const symbol of scan.codeIndex.symbols) {
    const file = fileById.get(symbol.fileId)
    if (!file) continue
    const score = scoreText(symbol.name, q) * 2 + scoreText(symbol.qualifiedName, q) + scoreText(file.path, q) * 0.5
    if (score <= 0) continue
    hits.push({
      id: symbol.id,
      kind: 'symbol',
      score,
      filePath: file.path,
      range: symbol.range,
      preview: `${symbol.kind} ${symbol.name}`,
      symbolIds: [symbol.id],
      provenance: req.mode === 'keyword' ? 'keyword' : 'hybrid',
    })
  }
  return {
    query: req.query,
    mode: req.mode ?? 'hybrid',
    hits: hits.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath)).slice(0, req.topK ?? 20),
  }
}

export function suggestMounts(projectId: string, intent: string, forest: CoordForest | null, scan: CodeMapScanResult | null): { hints: MountHint[] } {
  const rootId = forest?.rootId ?? `project-${projectId}`
  const q = normalizeIntent(intent)
  const nodes = forest ? Object.values(forest.nodes) : []
  const hints: MountHint[] = nodes
    .filter((node) => node.type !== 'project')
    .map((node) => {
      const score = scoreText(node.label, q) + scoreText(node.summary, q) + (node.tags ?? []).reduce((sum, tag) => sum + scoreText(tag, q), 0)
      return { node, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ node, score }) => ({
      nodeId: node.id,
      suggestedParentId: node.parentId ?? rootId,
      suggestedType: node.type === 'action' ? 'action' : node.type === 'goal' ? 'goal' : 'feature',
      label: node.label,
      rationale: `Matches "${intent}" against ${node.type} "${node.label}".`,
      score: Math.min(1, score / 6),
    }))

  if (hints.length === 0 && scan?.communities?.length) {
    return {
      hints: scan.communities.slice(0, 4).map((community) => ({
        suggestedParentId: rootId,
        suggestedType: 'feature',
        label: community.label,
        rationale: community.summary,
        score: Math.min(1, community.score / 12),
      })),
    }
  }

  return { hints }
}

export function compareScans(oldScan: CodeMapScanResult, newScan: CodeMapScanResult): ScanDiff {
  const oldFiles = new Map(oldScan.codeIndex.files.map((file) => [file.path, file] as const))
  const newFiles = new Map(newScan.codeIndex.files.map((file) => [file.path, file] as const))
  const oldSymbols = new Map(oldScan.codeIndex.symbols.map((symbol) => [symbol.qualifiedName, symbol] as const))
  const newSymbols = new Map(newScan.codeIndex.symbols.map((symbol) => [symbol.qualifiedName, symbol] as const))
  const oldCommunityByFile = buildCommunityMap(oldScan)
  const newCommunityByFile = buildCommunityMap(newScan)
  const entries: ScanDiffEntry[] = []

  for (const [pathName, file] of newFiles) {
    const prev = oldFiles.get(pathName)
    if (!prev) {
      entries.push(buildDiffEntry('file_added', file.id, pathName, undefined, { sha: file.sha, language: file.language }, 0.9))
      continue
    }
    if (prev.sha !== file.sha) {
      entries.push(buildDiffEntry('file_modified', file.id, pathName, { sha: prev.sha }, { sha: file.sha }, 0.7))
    }
    const oldCommunity = oldCommunityByFile.get(prev.id)
    const newCommunity = newCommunityByFile.get(file.id)
    if (oldCommunity && newCommunity && oldCommunity !== newCommunity) {
      entries.push(buildDiffEntry('community_shifted', file.id, pathName, { community: oldCommunity }, { community: newCommunity }, 0.6))
    }
  }

  for (const [pathName, file] of oldFiles) {
    if (!newFiles.has(pathName)) {
      entries.push(buildDiffEntry('file_removed', file.id, pathName, { sha: file.sha, language: file.language }, undefined, 0.9))
    }
  }

  for (const [qualifiedName, symbol] of newSymbols) {
    const prev = oldSymbols.get(qualifiedName)
    if (!prev) {
      const file = newScan.codeIndex.files.find((item) => item.id === symbol.fileId)
      entries.push(buildDiffEntry('symbol_added', symbol.id, file?.path, undefined, { kind: symbol.kind, name: symbol.name }, 0.8))
      continue
    }
    if (prev.range.startLine !== symbol.range.startLine || prev.range.endLine !== symbol.range.endLine || prev.kind !== symbol.kind) {
      const file = newScan.codeIndex.files.find((item) => item.id === symbol.fileId)
      entries.push(buildDiffEntry('symbol_modified', symbol.id, file?.path, { range: prev.range, kind: prev.kind }, { range: symbol.range, kind: symbol.kind }, 0.6))
    }
  }

  for (const [qualifiedName, symbol] of oldSymbols) {
    if (!newSymbols.has(qualifiedName)) {
      const file = oldScan.codeIndex.files.find((item) => item.id === symbol.fileId)
      entries.push(buildDiffEntry('symbol_removed', symbol.id, file?.path, { kind: symbol.kind, name: symbol.name }, undefined, 0.8))
    }
  }

  const summary = entries.length === 0
    ? 'No meaningful code changes detected.'
    : `Detected ${entries.length} change(s): ${entries.filter((entry) => entry.kind === 'file_added').length} added, ${entries.filter((entry) => entry.kind === 'file_removed').length} removed, ${entries.filter((entry) => entry.kind === 'file_modified').length} modified files.`

  return {
    projectId: newScan.projectId,
    oldScanId: oldScan.scanId,
    newScanId: newScan.scanId,
    oldSourceRevision: oldScan.source?.commitSha,
    newSourceRevision: newScan.source?.commitSha,
    entries,
    summary,
    stats: {
      fileAdded: entries.filter((entry) => entry.kind === 'file_added').length,
      fileRemoved: entries.filter((entry) => entry.kind === 'file_removed').length,
      fileModified: entries.filter((entry) => entry.kind === 'file_modified').length,
      symbolAdded: entries.filter((entry) => entry.kind === 'symbol_added').length,
      symbolRemoved: entries.filter((entry) => entry.kind === 'symbol_removed').length,
      symbolModified: entries.filter((entry) => entry.kind === 'symbol_modified').length,
      communityShifted: entries.filter((entry) => entry.kind === 'community_shifted').length,
    },
  }
}

function buildCommunityMap(scan: CodeMapScanResult): Map<string, string> {
  const mapping = new Map<string, string>()
  for (const community of scan.communities ?? []) {
    for (const fileId of community.fileIds) {
      mapping.set(fileId, community.id)
    }
  }
  return mapping
}

function buildDiffEntry(
  kind: ScanDiffEntry['kind'],
  entityId: string,
  pathValue: string | undefined,
  oldValue: Record<string, unknown> | undefined,
  newValue: Record<string, unknown> | undefined,
  significance = 0.5,
): ScanDiffEntry {
  return { kind, entityId, path: pathValue, oldValue, newValue, significance }
}

function scoreEntryFile(file: FileEntry, importCount: number, symbolCount: number): number {
  const base = pathBaseScore(file.path)
  return base + importCount * 1.5 + symbolCount * 1.2
}

function pathBaseScore(filePath: string): number {
  const base = filePath.split('/').at(-1) ?? filePath
  switch (base) {
    case 'app.ts':
    case 'app.tsx':
    case 'main.ts':
    case 'main.tsx':
    case 'server.ts':
    case 'server.js':
    case 'main.py':
    case 'main.go':
    case 'main.rs':
      return 10
    case 'index.ts':
    case 'index.tsx':
    case 'index.js':
      return 8
    default:
      return 2
  }
}

export function persistForest(projectId: string, scan: CodeMapScanResult): CoordForest {
  const forest = buildForestFromScan(scan)
  return contextService.saveCoordinatesState(projectId, forest, 'analyzer').forest
}
