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
  const labels = runLabelPropagation([...codeIndex.files.map((file) => file.id)], graph.fileNeighbors)
  const groups = new Map<string, string[]>()
  for (const [fileId, label] of labels) {
    const bucket = groups.get(label) ?? []
    bucket.push(fileId)
    groups.set(label, bucket)
  }

  const symbolIdsByFile = graph.symbolIdsByFile
  const fileById = new Map(codeIndex.files.map((file) => [file.id, file] as const))
  const orderedGroups = [...groups.values()]
    .map((fileIds) => fileIds.sort((left, right) => (fileById.get(left)?.path ?? '').localeCompare(fileById.get(right)?.path ?? '')))
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

function runLabelPropagation(fileIds: string[], neighbors: Map<string, Map<string, number>>): Map<string, string> {
  const labels = new Map(fileIds.map((fileId) => [fileId, fileId] as const))
  const order = [...fileIds].sort((left, right) => {
    const leftScore = [...(neighbors.get(left)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0)
    const rightScore = [...(neighbors.get(right)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0)
    return rightScore - leftScore || left.localeCompare(right)
  })

  for (let iteration = 0; iteration < 20; iteration += 1) {
    let changed = false
    for (const fileId of order) {
      const adjacent = neighbors.get(fileId)
      if (!adjacent || adjacent.size === 0) continue
      const scores = new Map<string, number>()
      for (const [neighborId, weight] of adjacent) {
        const label = labels.get(neighborId) ?? neighborId
        scores.set(label, (scores.get(label) ?? 0) + weight)
      }
      const best = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
      if (best && best !== labels.get(fileId)) {
        labels.set(fileId, best)
        changed = true
      }
    }
    if (!changed) break
  }

  return labels
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
  const crossImports = graph.resolvedImports.filter((edge) => fileIds.includes(edge.sourceFileId) && !fileIds.includes(edge.targetFileId)).length
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
      const callerFile = findFileForSymbol(callerId, graph)
      const calleeFile = findFileForSymbol(calleeId, graph)
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

function findFileForSymbol(symbolId: string, graph: AnalyzerGraph): string | null {
  for (const [fileId, symbolIds] of graph.symbolIdsByFile) {
    if (symbolIds.includes(symbolId)) return fileId
  }
  return null
}
