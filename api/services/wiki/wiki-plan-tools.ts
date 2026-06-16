import * as z from 'zod/v4'
import type { RegisteredTool } from '../agent-runtime/contracts.js'
import type { WikiDocument } from './contracts.js'

export interface PlanNodeDraft {
  title: string
  description: string
  goalIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
}

export interface PlanContext {
  projectId: string
  documentsById: Record<string, WikiDocument>
  onNodeSubmitted?: (node: PlanNodeDraft, index: number) => void
}

export function createPlanTools(context: PlanContext) {
  const submittedNodes: PlanNodeDraft[] = []

  const readWikiDocumentTool: RegisteredTool = {
    id: 'plan.read_wiki_document',
    label: 'Read Wiki Document',
    description: 'Read the full markdown content of a wiki document by its ID.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documentId: z.string().describe('The wiki document ID to read'),
    }),
    async execute(input) {
      const args = input.args as { documentId: string }
      const doc = context.documentsById[args.documentId]
      if (!doc) {
        return { result: { error: 'Document not found' }, displaySummary: `Document not found: ${args.documentId}`, artifacts: [] }
      }
      return {
        result: { documentId: doc.id, title: doc.title, contentMd: doc.contentMd, references: doc.references },
        displaySummary: `Read document ${doc.title}`,
        artifacts: [],
      }
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
      goalIds: z.array(z.string()).describe('Related goal IDs'),
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
    tools: [readWikiDocumentTool, submitNodeTool],
    getPlan: () => (submittedNodes.length > 0 ? submittedNodes : null),
  }
}
