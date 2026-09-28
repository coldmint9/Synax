import { z } from 'zod/v4';
export const mediaAdapterSchema = z.enum(['openai', 'xai', 'ark', 'minimax', 'openrouter']);
export const mediaOperationSchema = z.enum(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']);
export const mediaSelectionSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) });
export const mediaCapabilitiesSchema = z.object({
  operations: z.array(mediaOperationSchema).min(1),
  referenceRoles: z.array(z.enum(['reference', 'first_frame', 'last_frame'])).optional(),
  maxReferences: z.number().int().min(0).max(16).optional(),
  parameters: z.record(z.string(), z.object({ values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(), min: z.number().optional(), max: z.number().optional() })).optional(),
  streaming: z.boolean().optional(), polling: z.boolean().optional(), cancellation: z.boolean().optional(),
});
export const mediaJobInputSchema = mediaSelectionSchema.extend({
  operation: mediaOperationSchema,
  prompt: z.string().trim().min(1).max(32000),
  references: z.array(z.object({ assetId: z.string().regex(/^asset_[a-f0-9]{32}$/), role: z.enum(['reference', 'first_frame', 'last_frame']) })).max(16).default([]),
  parameters: z.record(z.string(), z.union([z.string().max(256), z.number().finite(), z.boolean()])).default({}),
  idempotencyKey: z.string().min(1).max(128),
}).strict();
