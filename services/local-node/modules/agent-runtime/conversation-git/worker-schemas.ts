import * as z from 'zod/v4';

const id = z.string().min(1).max(256);
const hunk = z.object({ hunkId: id, choice: z.enum(['base', 'target', 'source']).optional(), content: z.string().max(256 * 1024).optional() }).strict()
  .refine(value => value.choice ? value.content === undefined : value.content !== undefined, 'Provide a hunk choice or replacement content.');
export const resolveBatchInput = z.object({ files: z.array(z.object({ fileId: id, expectedRevision: id,
  hunks: z.array(hunk).min(1).max(100).optional(), choice: z.enum(['target', 'source', 'delete']).optional(),
}).strict().refine(value => value.choice ? value.hunks === undefined : value.hunks !== undefined, 'Provide hunk decisions or a structural/binary whole-file choice.')).min(1).max(20) }).strict();
export const packetInput = z.object({ fileId: id.optional(), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20).default(10), hunkOffset: z.number().int().min(0).default(0),
}).strict();
export const repairReadInput = z.object({ path: z.string().min(1).max(4096), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(48000).default(24000) }).strict();
export const repairInput = z.object({ files: z.array(z.object({ path: z.string().min(1).max(4096), expectedRevision: id,
  edits: z.array(z.object({ oldText: z.string().min(1).max(256 * 1024), newText: z.string().max(256 * 1024) }).strict()).min(1).max(30),
}).strict()).min(1).max(10) }).strict();
