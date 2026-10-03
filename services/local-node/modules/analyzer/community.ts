import path from 'node:path'
import type { SemanticEdge, SemanticGraph, SemanticNode } from '../contracts/forest.js'
import type { CodeMapCodeIndex, CodeMapCommunity, CodeMapSymbolSummary } from '../contracts/code-map.js'
import type { AnalyzerGraph } from './graph.js'
import { hashParts, topDirFromPath } from './shared.js'

export interface CommunityDetectionResult {
  communities: CodeMapCommunity[]
  semanticGraph: SemanticGraph
  communityByFileId: Map<string, string>
}

export function detectCommunities(codeIndex: CodeMapCodeIndex, graph: AnalyzerGraph): CommunityDetectionResult {
  const fileIds = codeIndex.files.map((file) => file.id)
  const partition = partitionBySizeBoundedAgglomeration(fileIds, graph)

  const symbolIdsByFile = graph.symbolIdsByFile
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))
  const orderedGroups = partition
    .map((ids) => ids.sort((left, right) => (fileById.get(left)?.path ?? '').localeCompare(fileById.get(right)?.path ?? '')))
    .sort((left, right) => scoreCommunity(right, graph) - scoreCommunity(left, graph) || compareCommunityPath(left, right, fileById))

  const communities: CodeMapCommunity[] = []
  const communityByFileId = new Map<string, string>()
  for (const [index, fileIds] of orderedGroups.entries()) {
    const communityId = `comm:${index}`
    const symbolIds = fileIds.flatMap((fileId) => symbolIdsByFile.get(fileId) ?? [])
    const hubSymbols = buildHubSymbols(codeIndex, graph, fileIds)
    const label = buildCommunityLabel(fileIds, fileById, hubSymbols, index)
    const summary = buildCommunitySummary(fileIds, symbolIds, graph, fileById)
    const score = scoreCommunity(fileIds, graph)
    const community: CodeMapCommunity = {
      id: communityId,
      label,
      summary,
      fileIds,
      symbolIds,
      hubSymbols,
      score,
      fileCount: fileIds.length,
      symbolCount: symbolIds.length,
    }
    communities.push(community)
    for (const fileId of fileIds) {
      communityByFileId.set(fileId, communityId)
    }
  }

  const semanticGraph = buildSemanticGraph(communities, graph, communityByFileId)
  return { communities, semanticGraph, communityByFileId }
}

// ── Size-bounded agglomerative partitioning ───────────────────────────────────
//
// Replaces label propagation, which is prone to the "monster community" failure:
// in graphs with a dense core or high-degree hubs (e.g. a flat directory where
// every file imports a shared types/utils module), one label avalanches and
// swallows most of the graph, producing a single giant package.
//
// Instead we grow clusters bottom-up by contracting the strongest edges first,
// and *refuse any merge that would exceed a size budget*. This makes giant
// communities structurally impossible and keeps each community at roughly one
// document's worth of code. Edge weights are normalized by endpoint degree
// (Salton index) so hub edges no longer dominate.
//
// Thresholds mirror the wiki SPLIT semantics (FILE_SPLIT=20 / SYM_SPLIT=80);
// kept local so the analyzer layer does not depend on the wiki layer.
const MAX_COMMUNITY_FILES = 20
const MAX_COMMUNITY_SYMBOLS = 80
const MIN_MERGE_SCORE = 0.04

interface MergeEdge {
  a: string
  b: string
  score: number
}

function partitionBySizeBoundedAgglomeration(fileIds: string[], graph: AnalyzerGraph): string[][] {
  if (fileIds.length === 0) return []

  const symbolsOf = (fileId: string): number => graph.symbolIdsByFile.get(fileId)?.length ?? 0
  const pathOf = (fileId: string): string => graph.fileToPath.get(fileId) ?? fileId

  const inScope = new Set(fileIds)
  const parent = new Map<string, string>()
  const clusterFiles = new Map<string, number>()
  const clusterSymbols = new Map<string, number>()
  for (const id of fileIds) {
    parent.set(id, id)
    clusterFiles.set(id, 1)
    clusterSymbols.set(id, symbolsOf(id))
  }

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  // Build undirected, deduplicated, degree-normalized candidate edges.
  const edges: MergeEdge[] = []
  const seen = new Set<string>()
  for (const [u, neighbors] of graph.fileNeighbors) {
    if (!inScope.has(u)) continue
    const degreeU = graph.fileDegree.get(u) ?? 0
    for (const [v, weight] of neighbors) {
      if (u === v || !inScope.has(v)) continue
      const key = u < v ? `${u}\u0000${v}` : `${v}\u0000${u}`
      if (seen.has(key)) continue
      seen.add(key)
      const degreeV = graph.fileDegree.get(v) ?? 0
      const denom = Math.sqrt(degreeU * degreeV) || 1
      const score = weight / denom
      if (score < MIN_MERGE_SCORE) continue
      edges.push({ a: u, b: v, score })
    }
  }

  edges.sort(
    (left, right) =>
      right.score - left.score ||
      pathOf(left.a).localeCompare(pathOf(right.a)) ||
      pathOf(left.b).localeCompare(pathOf(right.b)),
  )

  for (const edge of edges) {
    const rootA = find(edge.a)
    const rootB = find(edge.b)
    if (rootA === rootB) continue
    const mergedFiles = clusterFiles.get(rootA)! + clusterFiles.get(rootB)!
    if (mergedFiles > MAX_COMMUNITY_FILES) continue
    const mergedSymbols = clusterSymbols.get(rootA)! + clusterSymbols.get(rootB)!
    if (mergedSymbols > MAX_COMMUNITY_SYMBOLS) continue
    // Deterministic root: the cluster whose representative has the smaller path.
    const keep = pathOf(rootA) <= pathOf(rootB) ? rootA : rootB
    const drop = keep === rootA ? rootB : rootA
    parent.set(drop, keep)
    clusterFiles.set(keep, mergedFiles)
    clusterSymbols.set(keep, mergedSymbols)
  }

  const groups = new Map<string, string[]>()
  for (const id of fileIds) {
    const root = find(id)
    const bucket = groups.get(root) ?? []
    bucket.push(id)
    groups.set(root, bucket)
  }

  return repoolLeftovers([...groups.values()], graph)
}

// A 1-file group means the file could not merge into any neighbor — either it has
// no import/call edges, or every candidate merge was blocked by the size budget.
// Standalone singletons are pure noise as communities, so pool them by their
// folder and bin-pack within the same budget. A file that alone exceeds the
// symbol budget (e.g. a large generated module) stays its own community.
function repoolLeftovers(groups: string[][], graph: AnalyzerGraph): string[][] {
  const symbolsOf = (fileId: string): number => graph.symbolIdsByFile.get(fileId)?.length ?? 0
  const pathOf = (fileId: string): string => graph.fileToPath.get(fileId) ?? fileId

  const result: string[][] = []
  const leftoversByDir = new Map<string, string[]>()

  for (const group of groups) {
    if (group.length === 1) {
      const dir = path.posix.dirname(pathOf(group[0]))
      const bucket = leftoversByDir.get(dir) ?? []
      bucket.push(group[0])
      leftoversByDir.set(dir, bucket)
      continue
    }
    result.push(group)
  }

  for (const [, ids] of [...leftoversByDir.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    ids.sort((left, right) => pathOf(left).localeCompare(pathOf(right)))
    let bin: string[] = []
    let binSymbols = 0
    for (const id of ids) {
      const symbols = symbolsOf(id)
      const wouldOverflow = bin.length >= MAX_COMMUNITY_FILES || binSymbols + symbols > MAX_COMMUNITY_SYMBOLS
      if (bin.length > 0 && wouldOverflow) {
        result.push(bin)
        bin = []
        binSymbols = 0
      }
      bin.push(id)
      binSymbols += symbols
    }
    if (bin.length > 0) result.push(bin)
  }

  return result
}

function scoreCommunity(fileIds: string[], graph: AnalyzerGraph): number {
  return fileIds.reduce((sum, fileId) => sum + (graph.fileDegree.get(fileId) ?? 0.2), 0)
}

function compareCommunityPath(left: string[], right: string[], fileById: Map<string, { path: string }>): number {
  const leftPath = fileById.get(left[0])?.path ?? ''
  const rightPath = fileById.get(right[0])?.path ?? ''
  return leftPath.localeCompare(rightPath)
}

export function buildHubSymbols(codeIndex: CodeMapCodeIndex, graph: AnalyzerGraph, fileIds: string[]): CodeMapSymbolSummary[] {
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))
  const fileSet = new Set(fileIds)
  return codeIndex.symbols
    .filter((symbol) => fileSet.has(symbol.fileId))
    .filter((symbol) => isQualityHubName(symbol.name))
    .map((symbol) => ({
      id: symbol.id,
      fileId: symbol.fileId,
      path: fileById.get(symbol.fileId)?.path ?? symbol.fileId,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      degree: Math.round((graph.fileDegree.get(symbol.fileId) ?? 0) * 10) / 10,
      centrality: Math.min(1, (graph.fileDegree.get(symbol.fileId) ?? 0) / 6),
    }))
    .sort((left, right) => right.degree - left.degree || left.path.localeCompare(right.path) || left.name.localeCompare(right.name))
    .slice(0, 5)
}

function isQualityHubName(name: string): boolean {
  if (name.length <= 1) return false
  if (/^_?[a-z]\d*$/.test(name)) return false
  return true
}

function buildCommunityLabel(
  fileIds: string[],
  fileById: Map<string, { path: string }>,
  hubSymbols: CodeMapSymbolSummary[],
  index: number,
): string {
  const dirCounts = new Map<string, number>()
  for (const fileId of fileIds) {
    const pathName = fileById.get(fileId)?.path
    if (!pathName) continue
    const dir = topDirFromPath(pathName)
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }
  const [dominantDir, dominantCount = 0] = [...dirCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] ?? []
  if (dominantDir && dominantDir !== '.' && dominantCount / fileIds.length >= 0.5) {
    return dominantDir
  }
  const symbolName = hubSymbols[0]?.name
  return symbolName ? `${symbolName} cluster` : `community #${index}`
}

function buildCommunitySummary(
  fileIds: string[],
  symbolIds: string[],
  graph: AnalyzerGraph,
  fileById: Map<string, { path: string }>,
): string {
  const dirPreview = [...new Set(fileIds.map((fileId) => topDirFromPath(fileById.get(fileId)?.path ?? '.')))].slice(0, 3).join(', ')
  const fileSet = new Set(fileIds)
  const crossImports = graph.resolvedImports.filter((edge) => fileSet.has(edge.sourceFileId) && !fileSet.has(edge.targetFileId)).length
  return `${fileIds.length} files, ${symbolIds.length} symbols, ${crossImports} cross-community imports${dirPreview ? ` across ${dirPreview}` : ''}.`
}

function buildSemanticGraph(
  communities: CodeMapCommunity[],
  graph: AnalyzerGraph,
  communityByFileId: Map<string, string>,
): SemanticGraph {
  const nodes: SemanticNode[] = communities.map((community) => ({
    id: community.id,
    kind: 'module',
    label: community.label,
    summary: community.summary,
    evidence: { fileIds: community.fileIds, symbolIds: community.symbolIds },
    score: community.score,
  }))

  const symbolToFile = new Map<string, string>()
  for (const [fileId, symbolIds] of graph.symbolIdsByFile) {
    for (const symbolId of symbolIds) {
      symbolToFile.set(symbolId, fileId)
    }
  }

  const edgesByKey = new Map<string, SemanticEdge>()
  for (const edge of graph.resolvedImports) {
    const sourceCommunity = communityByFileId.get(edge.sourceFileId)
    const targetCommunity = communityByFileId.get(edge.targetFileId)
    if (!sourceCommunity || !targetCommunity || sourceCommunity === targetCommunity) continue
    const key = `imports:${sourceCommunity}->${targetCommunity}`
    const current = edgesByKey.get(key)
    if (current) {
      current.weight += edge.weight
      continue
    }
    edgesByKey.set(key, {
      id: `semantic_${hashParts(sourceCommunity, targetCommunity)}`,
      source: sourceCommunity,
      target: targetCommunity,
      kind: 'imports',
      weight: edge.weight,
    })
  }

  // Aggregate cross-community call edges
  for (const [callerId, callees] of graph.callGraph) {
    for (const calleeId of callees) {
      const callerFile = symbolToFile.get(callerId) ?? null
      const calleeFile = symbolToFile.get(calleeId) ?? null
      if (!callerFile || !calleeFile) continue
      const sourceCommunity = communityByFileId.get(callerFile)
      const targetCommunity = communityByFileId.get(calleeFile)
      if (!sourceCommunity || !targetCommunity || sourceCommunity === targetCommunity) continue
      const key = `calls:${sourceCommunity}->${targetCommunity}`
      const current = edgesByKey.get(key)
      if (current) {
        current.weight += 1
        continue
      }
      edgesByKey.set(key, {
        id: `semantic_call_${hashParts(sourceCommunity, targetCommunity)}`,
        source: sourceCommunity,
        target: targetCommunity,
        kind: 'calls',
        weight: 1,
      })
    }
  }

  return { nodes, edges: [...edgesByKey.values()] }
}
