import * as z from 'zod/v4'
import type { RegisteredTool } from '../agent-runtime/contracts.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'

export interface PlanNodeDraft {
  title: string
  description: string
  evaluationIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
}

export interface PlanContext {
  projectId: string
  blocksById: Record<string, WikiBlock>
  bindingsById: Record<string, WikiSourceBinding>
}

export function createPlanTools(context: PlanContext) {
  let submittedPlan: PlanNodeDraft[] | null = null

  const readWikiBlockTool: RegisteredTool = {
    id: 'plan.read_wiki_block',
    label: 'Read Wiki Block',
    description: 'Read the full content of a wiki block by its ID.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      blockId: z.string().describe('The wiki block ID to read'),
    }),
    async execute(input) {
      const args = input.args as { blockId: string }
      const block = context.blocksById[args.blockId]
      if (!block) {
        return { result: { error: 'Block not found' }, displaySummary: `Block not found: ${args.blockId}`, artifacts: [] }
      }
      return { result: { blockId: block.id, blockType: block.blockType, content: block.content }, displaySummary: `Read block ${args.blockId.slice(0, 8)}`, artifacts: [] }
    },
  }

  const submitPlanTool: RegisteredTool = {
    id: 'plan.submit_plan',
    label: 'Submit Plan',
    description: 'Submit the final execution plan with ordered nodes.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      nodes: z.array(z.object({
        title: z.string().describe('Short action title'),
        description: z.string().describe('What needs to be done and why'),
        evaluationIds: z.array(z.string()).describe('Related issue IDs'),
        dependsOn: z.array(z.string()).describe('Titles of nodes this depends on'),
        expectedFiles: z.array(z.string()).describe('Files expected to be modified'),
      })).min(1),
    }),
    async execute(input) {
      const args = input.args as { nodes: PlanNodeDraft[] }
      submittedPlan = args.nodes
      return {
        result: { ok: true, count: args.nodes.length },
        displaySummary: `Plan submitted: ${args.nodes.length} nodes`,
        artifacts: [{ kind: 'decision', title: 'Plan Generated', summary: `${args.nodes.length} action nodes`, risk: 'low' }],
      }
    },
  }

  return {
    tools: [readWikiBlockTool, submitPlanTool],
    getPlan: () => submittedPlan,
  }
}
