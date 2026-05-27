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
  onNodeSubmitted?: (node: PlanNodeDraft, index: number) => void
}

export function createPlanTools(context: PlanContext) {
  const submittedNodes: PlanNodeDraft[] = []

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

  const submitNodeTool: RegisteredTool = {
    id: 'plan.submit_node',
    label: 'Submit Plan Node',
    description: 'Submit a single plan node. Call once per node, in dependency order.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      title: z.string().describe('Short action title'),
      description: z.string().describe('What needs to be done and why'),
      evaluationIds: z.array(z.string()).describe('Related issue IDs'),
      dependsOn: z.array(z.string()).describe('Titles of previously submitted nodes this depends on'),
      expectedFiles: z.array(z.string()).describe('Files expected to be modified'),
    }),
    async execute(input) {
      const args = input.args as PlanNodeDraft
      const duplicate = submittedNodes.find(n => n.title === args.title)
      if (duplicate) {
        return { result: { error: `Node with title "${args.title}" already exists` }, displaySummary: `Duplicate: ${args.title}`, artifacts: [] }
      }
      submittedNodes.push(args)
      const index = submittedNodes.length - 1
      context.onNodeSubmitted?.(args, index)
      return {
        result: { ok: true, nodeIndex: index, title: args.title },
        displaySummary: `Node #${index + 1}: ${args.title}`,
        artifacts: [],
      }
    },
  }

  return {
    tools: [readWikiBlockTool, submitNodeTool],
    getPlan: () => (submittedNodes.length > 0 ? submittedNodes : null),
  }
}
