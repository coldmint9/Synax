import { logger } from '../../lib/logger.js'
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js'
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js'
import { toolRegistry } from '../agent-runtime/tool-registry.js'
import { wikiStore } from './wiki-store.js'
import { createPlanTools } from './wiki-plan-tools.js'
import { ensurePlanProfileRegistered } from './wiki-plan-profile.js'
import { buildPlanPrompt } from './wiki-plan-prompt.js'
import {
  listEvaluations,
  createPlan,
  createPlanNode,
  updateEvaluationStatus,
  type WikiEvaluation,
} from './wiki-evaluation-service.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'

export interface GeneratePlanResult {
  planId: string
  nodeCount: number
}

export async function generatePlan(
  projectId: string,
  snapshotId: string,
  workDir: string,
): Promise<GeneratePlanResult> {
  ensurePlanProfileRegistered()

  // 1. Collect context
  const issues = await listEvaluations(projectId, 'active')
  if (issues.length === 0) throw new Error('No active issues to plan')

  const tree = await wikiStore.getSnapshotTree(snapshotId)
  if (!tree) throw new Error('Snapshot not found')

  const blocksById: Record<string, WikiBlock> = {}
  for (const b of tree.blocks) blocksById[b.id] = b

  const bindingsById: Record<string, WikiSourceBinding> = {}
  for (const b of tree.sourceBindings) bindingsById[b.id] = b

  // Collect bindings for issue-related blocks
  const issueBlockIds = new Set(issues.map(e => e.blockId))
  const relevantBindings = tree.sourceBindings.filter(b => issueBlockIds.has(b.wikiBlockId))

  // Build wiki overview
  const wikiOverview = tree.documents
    .map(d => `- ${d.title} (${d.docType})`)
    .join('\n')

  // 2. Build prompt
  const prompt = buildPlanPrompt({
    issues,
    blocks: blocksById,
    bindings: relevantBindings,
    wikiOverview,
  })

  // 3. Register tools
  const handle = createPlanTools({ projectId, workDir, blocksById, bindingsById })
  const registeredToolIds: string[] = []
  for (const tool of handle.tools) {
    toolRegistry.register(tool)
    registeredToolIds.push(tool.id)
  }

  try {
    // 4. Create session and run loop
    const session = await agentSessionRuntime.create({
      projectId,
      profileId: 'plan-generator',
      initialMessages: [{ role: 'user', content: prompt }],
    })

    const stream = agentLoopRuntime.streamRun(session.id, {})
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
