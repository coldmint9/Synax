import type { CoordForest } from '../contracts/forest.js'
import type { ContextBinding, ContextSignal } from '../contracts/context.js'
import { compact, scoreText, topSentences } from './shared.js'
import { extractJsonObject, maybeGenerateStructuredText } from './llm.js'

export interface ExtractedContextSignal {
  kind: 'decision' | 'risk' | 'constraint' | 'evidence' | 'artifact' | 'correction' | 'insight'
  title: string
  summary: string
  content: string
  confidence: number
  tags: string[]
  sourceLinks: string[]
}

export interface ExtractedContextHandoff {
  signalTitle: string
  targetNodeId: string
  relation: 'uses' | 'references' | 'constrains' | 'resolves' | 'produces' | 'contains' | 'mentions' | 'discusses' | 'creates' | 'modifies'
  confidence: number
  reason: string
}

export interface ExtractContextSignalsRequest {
  projectId: string
  loopRecord: {
    id: string
    runId: string
    nodeId?: string | null
    summary?: string | null
    finalOutput?: string | null
    rawInput?: string | null
    steps?: Array<{ content?: string; kind?: string; title?: string }>
  }
  forest: CoordForest
  contextIndex: {
    signals?: ContextSignal[]
    bindings?: ContextBinding[]
  }
  locale?: 'zh' | 'en'
  workDir?: string | null
  model?: string
}

export interface ExtractContextSignalsResponse {
  signals: ExtractedContextSignal[]
  handoffs: ExtractedContextHandoff[]
  warnings: string[]
}

export async function extractContextSignals(req: ExtractContextSignalsRequest): Promise<ExtractContextSignalsResponse> {
  const prompt = buildContextSignalPrompt(req)
  const text = await maybeGenerateStructuredText('context-signal', req.projectId, prompt.system, prompt.user, req.model)
  if (text) {
    const parsed = extractJsonObject(text)
    if (parsed && typeof parsed === 'object') {
      const raw = parsed as Record<string, unknown>
      const signals = Array.isArray(raw.signals)
        ? raw.signals.filter((item): item is ExtractedContextSignal => Boolean(item) && typeof item === 'object')
        : []
      const handoffs = Array.isArray(raw.handoffs)
        ? raw.handoffs.filter((item): item is ExtractedContextHandoff => Boolean(item) && typeof item === 'object')
        : []
      const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string') : []
      if (signals.length > 0 || handoffs.length > 0) return { signals, handoffs, warnings }
    }
  }
  return extractContextSignalsHeuristically(req)
}

function buildContextSignalPrompt(req: ExtractContextSignalsRequest): { system: string; user: string } {
  const forest = req.forest
  const nodes = Object.values(forest.nodes ?? {}).slice(0, 80).map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    summary: node.summary,
    parentId: node.parentId,
    children: node.children ?? [],
    tags: node.tags ?? [],
  }))
  const loop = req.loopRecord
  return {
    system: 'You are a Synapse context-signal extractor. Return strict JSON matching {signals:[...], handoffs:[...], warnings:[...]} and nothing else.',
    user: JSON.stringify({
      projectId: req.projectId,
      sourceNodeId: loop.nodeId,
      runId: loop.runId,
      loopId: loop.id,
      rawInput: compact(loop.rawInput ?? '', 2_000),
      summary: compact(loop.summary ?? '', 1_000),
      finalOutput: compact(loop.finalOutput ?? '', 2_000),
      steps: Array.isArray(loop.steps) ? loop.steps.slice(0, 40).map((step) => ({
        kind: step.kind,
        title: step.title,
        content: compact(step.content ?? '', 400),
      })) : [],
      forest: {
        rootId: forest.rootId,
        nodes,
        edges: (forest.edges ?? []).slice(0, 100),
      },
      contextIndex: {
        signals: (req.contextIndex?.signals ?? []).slice(0, 30).map((signal) => ({ id: signal.id, kind: signal.kind, title: signal.title, sourceNodeId: signal.sourceNodeId })),
        bindings: (req.contextIndex?.bindings ?? []).slice(0, 80).map((binding) => ({ blockId: binding.blockId, targetKind: binding.targetKind, targetId: binding.targetId, relation: binding.relation })),
      },
    }, null, 2),
  }
}

function extractContextSignalsHeuristically(req: ExtractContextSignalsRequest): ExtractContextSignalsResponse {
  const loop = req.loopRecord ?? {}
  const contextIndex = req.contextIndex ?? { signals: [], bindings: [] }
  const sourceText = [
    loop.summary ?? '',
    loop.finalOutput ?? '',
    loop.rawInput ?? '',
    Array.isArray(loop.steps) ? loop.steps.map((step) => step.content ?? '').join('\n') : '',
  ].join('\n')
  const sentences = topSentences(sourceText, 6)
  const signals: ExtractedContextSignal[] = []
  const seen = new Set<string>()

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase()
    let kind: ExtractedContextSignal['kind'] = 'insight'
    if (/risk|warn|block|issue|fail|error|danger/.test(lower)) kind = 'risk'
    else if (/need|must|should|decide|decision|choose|approve/.test(lower)) kind = 'decision'
    else if (/constraint|limit|only|cannot|must not/.test(lower)) kind = 'constraint'
    else if (/fix|correct|rollback|undo/.test(lower)) kind = 'correction'
    else if (/artifact|file|patch|page|doc|wiki/.test(lower)) kind = 'artifact'
    else if (/evidence|because|since|due to/.test(lower)) kind = 'evidence'
    const title = compact(sentence.replace(/[.。！？!?]+$/, ''), 80)
    if (!title || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    signals.push({
      kind,
      title,
      summary: compact(sentence, 2_000),
      content: compact(sentence, 2_000),
      confidence: 0.65,
      tags: [kind],
      sourceLinks: [],
    })
    if (signals.length >= 5) break
  }

  const nodes = req.forest?.nodes ? Object.values(req.forest.nodes) : []
  const handoffs: ExtractedContextHandoff[] = []
  for (const signal of signals.slice(0, 8)) {
    const target = nodes
      .filter((node) => node.type !== 'project')
      .map((node) => ({ node, score: scoreText(node.label, signal.title) + scoreText(node.summary, signal.summary) }))
      .sort((left, right) => right.score - left.score)[0]
    if (!target || target.score <= 0) continue
    handoffs.push({
      signalTitle: signal.title,
      targetNodeId: target.node.id,
      relation: signal.kind === 'decision'
        ? 'resolves'
        : signal.kind === 'risk'
          ? 'constrains'
          : signal.kind === 'artifact'
            ? 'produces'
            : signal.kind === 'correction'
              ? 'modifies'
              : 'references',
      confidence: 0.7,
      reason: `Matches ${signal.kind} signal to ${target.node.type} "${target.node.label}".`,
    })
  }

  return {
    signals,
    handoffs,
    warnings: contextIndex.bindings?.length ? [] : ['No prior bindings were available for handoff calibration.'],
  }
}
