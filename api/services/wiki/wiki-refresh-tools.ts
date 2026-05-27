import * as z from 'zod/v4'
import type { RegisteredTool } from '../agent-runtime/contracts.js'
import type { WikiBlock } from './contracts.js'

export interface DraftChangeDraft {
  blockId: string
  action: 'update' | 'delete' | 'insert_after'
  newContent: unknown
  reasoning: string
}

export interface RefreshToolContext {
  allBlocks: WikiBlock[]
  affectedBlockIds: string[]
  documentTitle: string
}

export function createRefreshTools(context: RefreshToolContext) {
  let submittedSummary: string | null = null
  let submittedChanges: DraftChangeDraft[] = []

  const readBlockTool: RegisteredTool = {
    id: 'refresh.read_block',
    label: 'Read Wiki Block',
    description: 'Read the full content of a wiki block by ID.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      blockId: z.string().describe('The wiki block ID to read'),
    }),
    async execute(input) {
      const args = input.args as { blockId: string }
      const block = context.allBlocks.find(b => b.id === args.blockId)
      if (!block) {
        return { result: { error: 'Block not found' }, displaySummary: `Block not found: ${args.blockId}`, artifacts: [] }
      }
      return {
        result: { blockId: block.id, blockType: block.blockType, contentFormat: block.contentFormat, content: block.content },
        displaySummary: `Read block ${block.blockType} [${args.blockId.slice(0, 8)}]`,
        artifacts: [],
      }
    },
  }

  const submitChangesTool: RegisteredTool = {
    id: 'refresh.submit_changes',
    label: 'Submit Draft Changes',
    description: 'Submit the final set of block changes for this document. Call once with all changes.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      summary: z.string().describe('One-line summary of what changed in this document'),
      changes: z.array(z.object({
        blockId: z.string().describe('ID of the block to modify'),
        action: z.enum(['update', 'delete', 'insert_after']).describe('Type of change'),
        newContent: z.record(z.string(), z.unknown()).optional().describe('New block content object matching original format'),
        reasoning: z.string().describe('One sentence explaining why this block needs updating'),
      })),
    }),
    async execute(input) {
      const args = input.args as { summary: string; changes: DraftChangeDraft[] }
      submittedSummary = args.summary
      submittedChanges = args.changes
      return {
        result: { ok: true, count: args.changes.length },
        displaySummary: `Submitted ${args.changes.length} changes for "${context.documentTitle}"`,
        artifacts: [],
      }
    },
  }

  return {
    tools: [readBlockTool, submitChangesTool],
    getResult: () => submittedChanges.length > 0 ? { summary: submittedSummary, changes: submittedChanges } : null,
  }
}
