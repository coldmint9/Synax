import {
  contentPartsSchema,
  normalizeInput,
  hasInput,
  inputParts,
} from "./content-parts.js";
import { bindAssets } from "./media-assets.js";
import { turnReferenceSchema } from "./contracts.js";
import { prepareTurnReferences } from "./turn-references.js";
import type { TurnReferenceContext } from "./turn-reference-state.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { z } from "zod";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore } from "./session-store.js";

export const MAX_INPUT_QUEUE_SIZE = 20;

export const queuedInputSchema = z.object({
  contentParts: contentPartsSchema.optional(),
  references: z.array(turnReferenceSchema).max(20).optional(),
  referenceContext: z.custom<TurnReferenceContext>().optional(),
  id: z.string().min(1),
  message: z.string().max(100_000).default(""),
  model: z.string().min(1).max(256).nullable().optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
  enqueuedAt: z.string().min(1),
});

export type QueuedInput = z.infer<typeof queuedInputSchema>;

export type QueuedMoveTarget =
  | { direction: "up" | "down" }
  | { toIndex: number };

export const enqueueInputRequestSchema = z.object({
  contentParts: contentPartsSchema.optional(),
  references: z.array(turnReferenceSchema).max(20).optional(),
  message: z.string().max(100_000).default(""),
  model: z.string().min(1).max(256).optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
});

export type EnqueueInputRequest = z.infer<typeof enqueueInputRequestSchema>;
