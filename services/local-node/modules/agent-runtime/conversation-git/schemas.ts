import * as z from 'zod/v4';
const id = z.string().trim().min(1).max(160);
export const conversationGitCheckSchema = z.object({
  id: z.string().trim().min(1).max(80),
  executable: z.string().min(1).max(500).refine(value => !value.includes('\0')),
  args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(100),
  timeoutMs: z.number().int().min(1000).max(600000),
}).strict();
export const conversationGitInputSchema = z.object({
  rootId: id.optional(),
  title: z.string().trim().min(1).max(200),
  target: z.string().min(1).max(250),
  sources: z.array(z.string().min(1).max(250)).min(1).max(30),
  strategy: z.enum(['merge_commit', 'squash', 'ff_only']).default('merge_commit'),
  checks: z.array(conversationGitCheckSchema).max(10).refine(checks => new Set(checks.map(check => check.id)).size === checks.length, 'Check IDs must be unique.').optional(),
  allowCheckedOutTarget: z.boolean().optional(),
}).strict();
export const conversationGitCreateSchema = conversationGitInputSchema.extend({ requestId: id });
export const conversationGitActionSchema = z.object({
  action: z.enum(['prepare', 'continue', 'checks', 'finalize', 'cancel', 'pause', 'resume', 'replan']),
  skipChecks: z.boolean().optional(),
  requestId: id,
  expectedVersion: z.number().int().positive(),
  expectedTaskRevision: z.number().int().positive(),
}).strict().refine(value => value.skipChecks !== true || value.action === 'finalize', 'Skipping checks requires an explicit finalize action.');
export const conversationGitSaveSchema = z.object({
  requestId: id,
  expectedVersion: z.number().int().positive(),
  expectedTaskRevision: z.number().int().positive(),
  expectedRevision: z.string().min(1).max(256),
  content: z.string().max(2 * 1024 * 1024).optional(),
  choice: z.enum(['target', 'source', 'delete']).optional(),
  resolve: z.boolean(),
  resolutionState: z.unknown().optional(),
}).strict().refine(value => value.choice ? value.content === undefined : value.content !== undefined, 'Provide content or a whole-file choice, never both.');
export const conversationGitApplySchema = z.object({
  proposalId: id,
  requestId: id,
  expectedVersion: z.number().int().positive(),
  expectedTaskRevision: z.number().int().positive(),
}).strict();
export const conversationGitReadSchema = z.object({ objectId: id.optional(), fileId: id.optional(), side: z.enum(['base','target','source','result']).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(48000).default(24000), byteOffset: z.number().int().min(0).optional(), expectedRevision: z.string().min(1).max(256).optional() }).strict().refine(value => !value.fileId || !!value.objectId, 'fileId requires objectId.').refine(value => value.byteOffset === undefined || Boolean(value.side && value.fileId && value.expectedRevision), 'Byte paging requires side, fileId and expectedRevision.');
export const conversationGitProposalSchema = z.object({
  objectId: id,
  fileId: id,
  revision: z.string().min(1).max(256),
  content: z.string().max(2 * 1024 * 1024),
  rationale: z.string().trim().min(1).max(16000),
}).strict();

export const conversationGitAnalyzeSchema = z.object({ objectId: id, expectedVersion: z.number().int().positive(), expectedTaskRevision: z.number().int().positive() }).strict();
export const conversationGitResumeSchema = z.object({
  objectId: id,
  instructions: z.string().trim().min(1).max(16_000).optional().describe('Current user decisions or additional merge instructions to deliver to the resumed worker.'),
}).strict();
export const conversationGitConfigureSchema = conversationGitAnalyzeSchema.extend({ checks: z.array(conversationGitCheckSchema).min(1).max(10).refine(checks => new Set(checks.map(check => check.id)).size === checks.length, 'Check IDs must be unique.') }).strict();
export const conversationGitSliceSchema = z.object({ side: z.enum(['base', 'target', 'source', 'result']), byteOffset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER), maxBytes: z.coerce.number().int().min(4).max(256 * 1024).default(64 * 1024), expectedRevision: z.string().min(1).max(256) }).strict();
