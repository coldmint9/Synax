import * as z from 'zod/v4'
import fs from 'node:fs'
import path from 'node:path'
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
  workDir: string
  blocksById: Record<string, WikiBlock>
  bindingsById: Record<string, WikiSourceBinding>
}

export function createPlanTools(context: PlanContext) {
  let submittedPlan: PlanNodeDraft[] | null = null

  const readSourceTool: RegisteredTool = {
    id: 'plan.read_source',
    label: 'Read Source File',
    description: 'Read a source file from the project to understand implementation details.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      filePath: z.string().describe('Relative file path from project root'),
      startLine: z.number().optional().describe('Start line (1-based)'),
      endLine: z.number().optional().describe('End line (1-based)'),
    }),
    async execute(input) {
      const args = input.args as { filePath: string; startLine?: number; endLine?: number }
      const fullPath = path.resolve(context.workDir, args.filePath)
      if (!fullPath.startsWith(context.workDir)) {
        return { result: { error: 'Path outside project' }, displaySummary: 'Rejected: path outside project', artifacts: [] }
      }
      try {
        const content = fs.readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        const start = (args.startLine ?? 1) - 1
        const end = args.endLine ?? lines.length
        const slice = lines.slice(start, end).join('\n')
        return { result: { content: slice, totalLines: lines.length }, displaySummary: `Read ${args.filePath} (${end - start} lines)`, artifacts: [] }
      } catch {
        return { result: { error: 'File not found' }, displaySummary: `File not found: ${args.filePath}`, artifacts: [] }
      }
    },
  }

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
    tools: [readSourceTool, readWikiBlockTool, submitPlanTool],
    getPlan: () => submittedPlan,
  }
}
