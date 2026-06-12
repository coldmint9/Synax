import * as z from 'zod/v4'
import type { RegisteredTool } from '../agent-runtime/contracts.js'
import type { WikiDocument } from './contracts.js'

export interface DraftDocumentChangeDraft {
  documentId: string
  newContentMd: string
  reasoning: string
}

export interface RefreshToolContext {
  document: WikiDocument
  documentTitle: string
}

export function createRefreshTools(context: RefreshToolContext) {
  let submittedSummary: string | null = null
  let submittedChange: DraftDocumentChangeDraft | null = null

  const readDocumentTool: RegisteredTool = {
    id: 'refresh.read_document',
    label: 'Read Wiki Document',
    description: 'Read the full markdown content of the current wiki document.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({}),
    async execute() {
      return {
        result: {
          documentId: context.document.id,
          title: context.document.title,
          contentMd: context.document.contentMd,
          references: context.document.references,
        },
        displaySummary: `Read document "${context.documentTitle}"`,
        artifacts: [],
      }
    },
  }

  const submitChangesTool: RegisteredTool = {
    id: 'refresh.submit_changes',
    label: 'Submit Document Update',
    description: 'Submit the updated markdown for this document. Call once with the full revised body.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      summary: z.string().describe('One-line summary of what changed in this document'),
      newContentMd: z.string().describe('Full updated markdown body for the document'),
      reasoning: z.string().describe('Why the document needs updating based on code changes'),
    }),
    async execute(input) {
      const args = input.args as { summary: string; newContentMd: string; reasoning: string }
      submittedSummary = args.summary
      submittedChange = {
        documentId: context.document.id,
        newContentMd: args.newContentMd,
        reasoning: args.reasoning,
      }
      return {
        result: { ok: true },
        displaySummary: `Submitted update for "${context.documentTitle}"`,
        artifacts: [],
      }
    },
  }

  return {
    tools: [readDocumentTool, submitChangesTool],
    getResult: () => submittedChange ? { summary: submittedSummary, change: submittedChange } : null,
  }
}
