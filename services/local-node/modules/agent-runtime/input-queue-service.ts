export const inputQueueService = {
  list: (_sessionId:string) => [],
  getForceInjectId: (_sessionId:string) => null,
  enqueue: (_sessionId:string,_input:unknown) => { throw new Error("Rust input queue is authoritative."); },
  remove: (_sessionId:string,_id:string) => { throw new Error("Rust input queue is authoritative."); },
  move: (_sessionId:string,_id:string,_target:unknown) => { throw new Error("Rust input queue is authoritative."); },
  markForceInject: (_sessionId:string,_id:string) => { throw new Error("Rust input queue is authoritative."); },
  clearForceInject: (_sessionId:string) => { throw new Error("Rust input queue is authoritative."); },
  consumeForced: (_sessionId:string) => null,
};
import {
  contentPartsSchema,
} from "./content-parts.js";
import { turnReferenceSchema } from "./contracts.js";
import type { TurnReferenceContext } from "./turn-reference-state.js";
import { z } from "zod";
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
