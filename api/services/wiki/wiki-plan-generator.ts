import { logger } from '../../lib/logger.js'
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js'
import { streamWikiAgent } from './wiki-agent-stream.js'
import { toolRegistry } from '../agent-runtime/tool-registry.js'
import { wikiStore } from './wiki-store.js'
import { createPlanTools, type PlanNodeDraft } from './wiki-plan-tools.js'
import { ensurePlanProfileRegistered } from './wiki-plan-profile.js'
import { buildPlanPrompt } from './wiki-plan-prompt.js'
import {
  listEvaluations,
  createPlan,
  createPlanNode,
  updateEvaluationStatus,
  type WikiEvaluation,
} from './wiki-evaluation-service.js'
import type { WikiDocument } from './contracts.js'

export interface GeneratePlanResult {
  planId: string
  nodeCount: number
}

export type PlanStreamEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'phase'; phase: 'analyzing' | 'reading_source' | 'planning' | 'submitting' }
  | { type: 'tool_call'; tool: string; summary: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message_delta'; delta: string }
  | { type: 'node_submitted'; node: PlanNodeDraft; index: number }
  | { type: 'completed'; planId: string; nodeCount: number }
  | { type: 'failed'; error: string }

export async function generatePlan(
  projectId: string,
  snapshotId: string,
  locale: 'zh' | 'en' = 'zh',
): Promise<GeneratePlanResult> {
  ensurePlanProfileRegistered()

  // 1. Collect context
  const issues = await listEvaluations(projectId, 'active')
  if (issues.length === 0) throw new Error('No active issues to plan')

  const tree = await wikiStore.getSnapshotTree(snapshotId)
  if (!tree) throw new Error('Snapshot not found')

  const documentsById: Record<string, WikiDocument> = {}
  for (const d of tree.documents) documentsById[d.id] = d

  const wikiOverview = tree.documents
    .map(d => `- ${d.title} (${d.docType})`)
    .join('\n')

  const prompt = buildPlanPrompt({
    issues,
    documents: documentsById,
    wikiOverview,
    locale,
  })

  const handle = createPlanTools({ projectId, documentsById })
  const registeredToolIds: string[] = []
  for (const tool of handle.tools) {
    toolRegistry.register(tool)
    registeredToolIds.push(tool.id)
  }

  try {
    // 4. Create session and run loop
    const session = agentSessionRuntime.create({
      projectId,
      profileId: 'plan-generator',
      prompt,
    })

    const stream = streamWikiAgent(session.id, { locale })
    for await (const chunk of stream) {
      if (chunk.type === 'run_failed') {
        throw new Error(`Plan generation failed: ${chunk.error}`)
      }
      if (chunk.type === 'done') break
    }

    // 5. Extract results and persist
    const planNodes = handle.getPlan()
    if (!planNodes || planNodes.length === 0) {
      throw new Error('Agent did not produce a plan')
    }

    const plan = await createPlan(projectId, snapshotId, issues.map(e => e.id))
    for (const [i, node] of planNodes.entries()) {
      await createPlanNode({
        planId: plan.id,
        projectId,
        title: node.title,
        description: node.description,
        evaluationIds: node.evaluationIds,
        dependsOn: node.dependsOn,
        expectedFiles: node.expectedFiles,
        sortOrder: i,
      })
    }

    // 6. Update issues status to 'planned'
    for (const issue of issues) {
      await updateEvaluationStatus(issue.id, 'planned')
    }

    logger.info({ planId: plan.id, nodeCount: planNodes.length }, 'Plan generated')
    return { planId: plan.id, nodeCount: planNodes.length }
  } finally {
    // 7. Cleanup
    for (const tid of registeredToolIds) {
      toolRegistry.unregister(tid)
    }
  }
}

export async function* generatePlanStream(
  projectId: string,
  snapshotId: string,
  locale: 'zh' | 'en' = 'zh',
): AsyncGenerator<PlanStreamEvent> {
  ensurePlanProfileRegistered()

  const issues = await listEvaluations(projectId, 'active')
  if (issues.length === 0) throw new Error('No active issues to plan')

  const tree = await wikiStore.getSnapshotTree(snapshotId)
  if (!tree) throw new Error('Snapshot not found')

  const documentsById: Record<string, WikiDocument> = {}
  for (const d of tree.documents) documentsById[d.id] = d
  const wikiOverview = tree.documents.map(d => `- ${d.title} (${d.docType})`).join('\n')

  const prompt = buildPlanPrompt({ issues, documents: documentsById, wikiOverview, locale })

  const pendingNodeEvents: PlanStreamEvent[] = []
  const handle = createPlanTools({
    projectId, documentsById,
    onNodeSubmitted: (node, index) => {
      pendingNodeEvents.push({ type: 'node_submitted', node, index })
    },
  })
  const registeredToolIds: string[] = []
  for (const tool of handle.tools) {
    toolRegistry.register(tool)
    registeredToolIds.push(tool.id)
  }

  try {
    const session = agentSessionRuntime.create({ projectId, profileId: 'plan-generator', prompt })
    yield { type: 'started', sessionId: session.id }
    yield { type: 'phase', phase: 'analyzing' }

    const stream = streamWikiAgent(session.id, { locale })
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'tool_call': {
          const toolId = chunk.toolCall?.toolId ?? ''
          if (toolId === 'plan.read_wiki_document') {
            yield { type: 'tool_call', tool: 'read_wiki_document', summary: chunk.toolCall?.inputSummary ?? '' }
          } else if (toolId === 'grep.search') {
            yield { type: 'phase', phase: 'reading_source' }
            yield { type: 'tool_call', tool: 'grep_search', summary: chunk.toolCall?.inputSummary ?? '' }
          } else if (toolId === 'file.read') {
            yield { type: 'phase', phase: 'reading_source' }
            yield { type: 'tool_call', tool: 'file_read', summary: chunk.toolCall?.inputSummary ?? '' }
          } else if (toolId === 'plan.submit_node') {
            yield { type: 'phase', phase: 'submitting' }
          }
          break
        }
        case 'thought_delta':
          yield { type: 'phase', phase: 'planning' }
          yield { type: 'thought_delta', delta: chunk.delta }
          break
        case 'message_delta':
          yield { type: 'message_delta', delta: chunk.delta }
          break
        case 'run_failed':
          yield { type: 'failed', error: chunk.error ?? 'Unknown error' }
          return
        case 'done':
          break
      }
      // Drain pending node events after each chunk
      while (pendingNodeEvents.length > 0) {
        yield pendingNodeEvents.shift()!
      }
      if (chunk.type === 'done') break
    }

    // Persist plan
    const planNodes = handle.getPlan()
    if (!planNodes || planNodes.length === 0) {
      yield { type: 'failed', error: 'Agent did not produce a plan' }
      return
    }

    const plan = await createPlan(projectId, snapshotId, issues.map(e => e.id))
    for (const [i, node] of planNodes.entries()) {
      await createPlanNode({
        planId: plan.id, projectId,
        title: node.title, description: node.description,
        evaluationIds: node.evaluationIds, dependsOn: node.dependsOn,
        expectedFiles: node.expectedFiles, sortOrder: i,
      })
    }
    for (const issue of issues) {
      await updateEvaluationStatus(issue.id, 'planned')
    }

    logger.info({ planId: plan.id, nodeCount: planNodes.length }, 'Plan generated (stream)')
    yield { type: 'completed', planId: plan.id, nodeCount: planNodes.length }
  } finally {
    for (const tid of registeredToolIds) {
      toolRegistry.unregister(tid)
    }
  }
}
