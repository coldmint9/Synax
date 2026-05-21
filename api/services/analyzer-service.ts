import type { CoordForest, SourceBinding } from './contracts/forest.js'
import type {
  CodeMapScanRequest,
  CodeMapScanResult,
} from './contracts/code-map.js'
import type { GoalReviewRequest } from './contracts/review.js'
import type { HybridResult, MountHint, SearchMode } from './contracts/search.js'
import { workspaceRoot } from './agent-runtime/tools/workspace.js'
import { contextService } from './context/context-service.js'
import {
  extractContextSignals as extractContextSignalsImpl,
  type ExtractContextSignalsRequest,
  type ExtractContextSignalsResponse,
} from './analyzer/context-signals.js'
import { buildReviewPackage } from './analyzer/review.js'
import {
  buildForestFromScan,
  persistForest,
  runCodeMapScan,
  searchScan,
  suggestMounts,
  type ScanDiff,
} from './analyzer/scan.js'
import { uid } from './analyzer/shared.js'

export type LocalAnalyzerEvent = { type: string; payload: unknown }
const latestScanByProject = new Map<string, CodeMapScanResult>()

interface SearchRequest {
  projectId: string
  query: string
  mode?: SearchMode
  topK?: number
  alpha?: number
}

interface SuggestMountRequest {
  projectId: string
  intent: string
}

export type { ExtractContextSignalsRequest, ExtractContextSignalsResponse, ScanDiff }

async function* emitAnalyzeStream(input: {
  projectId: string
  source: SourceBinding
  locale?: 'zh' | 'en'
  workDir?: string | null
  incremental?: boolean
}): AsyncGenerator<LocalAnalyzerEvent> {
  const runId = uid('anl')
  yield { type: 'analysis_started', payload: { projectId: input.projectId, runId, startedAt: Date.now() } }

  const scanInput: CodeMapScanRequest = {
    projectId: input.projectId,
    source: input.source,
    workDir: input.workDir ?? input.source.localPath ?? undefined,
    include: ['all'],
  }

  yield { type: 'analysis_cloning', payload: { phase: 'cloning', progress: 5, message: 'Preparing local workspace' } }
  const scan = await runCodeMapScan(scanInput)
  yield { type: 'analysis_parsing', payload: { phase: 'parsing', progress: 25, message: `Parsed ${scan.codeIndex.files.length} files` } }
  yield { type: 'analysis_graph_build', payload: { phase: 'graph_build', progress: 45, message: `Built ${scan.semanticGraph.nodes.length} semantic nodes` } }
  yield { type: 'analysis_semantic', payload: { phase: 'semantic', progress: 60, message: `Discovered ${scan.communities?.length ?? 0} communities` } }
  yield { type: 'analysis_indexing', payload: { phase: 'indexing', progress: 75, message: `Indexed ${scan.codeIndex.stats.symbolCount} symbols` } }
  yield { type: 'analysis_mapping', payload: { phase: 'mapping', progress: 90, message: 'Assembling CoordForest' } }

  const forest = persistForest(input.projectId, scan)
  yield {
    type: 'analysis_completed',
    payload: {
      runId,
      projectId: input.projectId,
      forest,
      commitSha: scan.source?.commitSha ?? undefined,
      report: forest.analysis.report,
    },
  }
}

function* emitReviewStream(input: GoalReviewRequest): Generator<LocalAnalyzerEvent> {
  const packageData = buildReviewPackage(input)
  yield { type: 'review_started', payload: { run: packageData.run } }
  for (const log of packageData.agentLog) {
    yield { type: 'review_turn', payload: log }
    yield { type: 'review_tool_result', payload: { turn: log.turn, tool: log.tool, resultSummary: log.resultSummary ?? '' } }
  }
  for (const decision of packageData.decisions) {
    yield { type: 'review_action_decision', payload: decision }
  }
  yield { type: 'review_completed', payload: { package: packageData } }
}

export async function scanCodeMap(req: CodeMapScanRequest): Promise<CodeMapScanResult> {
  const result = await runCodeMapScan(req)
  latestScanByProject.set(req.projectId, result)
  return result
}

export async function search(req: SearchRequest): Promise<HybridResult> {
  return searchScan(req, latestScanByProject.get(req.projectId) ?? null)
}

export async function suggestMount(req: SuggestMountRequest): Promise<{ hints: MountHint[] }> {
  return suggestMounts(
    req.projectId,
    req.intent,
    contextService.getCoordinatesState(req.projectId)?.forest ?? null,
    latestScanByProject.get(req.projectId) ?? null,
  )
}

export async function fetchForest(projectId: string): Promise<CoordForest | null> {
  return contextService.getCoordinatesState(projectId)?.forest ?? null
}

export async function extractContextSignals(req: ExtractContextSignalsRequest): Promise<ExtractContextSignalsResponse> {
  return extractContextSignalsImpl(req)
}

export async function* streamAnalyzerSse(
  upstreamPath: '/analyze' | '/reanalyze' | '/review/goal',
  body: unknown,
): AsyncGenerator<LocalAnalyzerEvent> {
  if (upstreamPath === '/analyze' || upstreamPath === '/reanalyze') {
    const parsed = body as { projectId?: string; source?: SourceBinding; workDir?: string | null; locale?: 'zh' | 'en' }
    if (!parsed?.projectId || !parsed?.source) {
      yield { type: 'analysis_failed', payload: { reason: 'Missing projectId or source' } }
      return
    }
    yield* emitAnalyzeStream({
      projectId: parsed.projectId,
      source: parsed.source,
      locale: parsed.locale,
      workDir: parsed.workDir ?? null,
      incremental: upstreamPath === '/reanalyze',
    })
    return
  }

  if (upstreamPath === '/review/goal') {
    const parsed = body as GoalReviewRequest
    try {
      yield* emitReviewStream(parsed)
    } catch (err) {
      yield { type: 'review_failed', payload: { reason: err instanceof Error ? err.message : String(err) } }
    }
  }
}

export function buildLocalAnalyzerHealth(): Record<string, unknown> {
  return {
    ok: true,
    mode: 'local-bun',
    workspaceRoot: workspaceRoot(),
  }
}

export function buildForestForTests(scan: CodeMapScanResult): CoordForest {
  return buildForestFromScan(scan)
}
