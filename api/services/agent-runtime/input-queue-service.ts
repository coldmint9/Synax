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

const INPUT_QUEUE_METADATA_KEY = "inputQueue";
const FORCE_INJECT_METADATA_KEY = "inputForceInjectId";

function readForceInjectId(
  sessionMetadata: Record<string, unknown> | null | undefined,
): string | null {
  const raw = sessionMetadata?.[FORCE_INJECT_METADATA_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readQueue(
  sessionMetadata: Record<string, unknown> | null | undefined,
): QueuedInput[] {
  const raw = sessionMetadata?.[INPUT_QUEUE_METADATA_KEY];
  const parsed = z.array(queuedInputSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function writeQueue(sessionId: string, items: QueuedInput[]): QueuedInput[] {
  agentRuntimeStore.updateSessionMetadata(sessionId, {
    [INPUT_QUEUE_METADATA_KEY]: items,
  });
  emitRuntimeBusEvent({
    type: "session_input_queue_changed",
    sessionId,
    patch: { queueSize: items.length },
  });
  return items;
}

function assertSessionExists(sessionId: string): void {
  agentRuntimeStore.getSession(sessionId);
}

export const inputQueueService = {
  list(sessionId: string): QueuedInput[] {
    assertSessionExists(sessionId);
    const session = agentRuntimeStore.getSession(sessionId);
    return readQueue(session.sessionMetadata);
  },

  enqueue(sessionId: string, input: EnqueueInputRequest): QueuedInput[] {
    input = normalizeInput(input);
    if (!hasInput(input)) throw new AgentValidationError("Input is empty.");
    return runtimeTransaction(() => {
      assertSessionExists(sessionId);
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      if (queue.length >= MAX_INPUT_QUEUE_SIZE) {
        throw new AgentValidationError(
          `Input queue is full (max ${MAX_INPUT_QUEUE_SIZE}).`,
        );
      }
      bindAssets(sessionId, inputParts(input));
      const item: QueuedInput = {
        contentParts: input.contentParts,
        id: makeRuntimeId("inq"),
        message: input.message.trim(),
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort,
        enqueuedAt: nowIso(),
        references: input.references,
        referenceContext: prepareTurnReferences(sessionId, input.references),
      };
      return writeQueue(sessionId, [...queue, item]);
    });
  },

  remove(sessionId: string, itemId: string): QueuedInput[] {
    return runtimeTransaction(() => {
      assertSessionExists(sessionId);
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      const next = queue.filter((item) => item.id !== itemId);
      if (next.length === queue.length) {
        throw new AgentValidationError("Queued input not found.");
      }
      if (readForceInjectId(session.sessionMetadata) === itemId)
        this.clearForceInject(sessionId);
      return writeQueue(sessionId, next);
    });
  },

  move(
    sessionId: string,
    itemId: string,
    target: QueuedMoveTarget,
  ): QueuedInput[] {
    return runtimeTransaction(() => {
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      const index = queue.findIndex((item) => item.id === itemId);
      if (index === -1)
        throw new AgentValidationError(
          "Queued input not found. It may already be running.",
        );
      const to =
        "toIndex" in target
          ? target.toIndex
          : index + (target.direction === "up" ? -1 : 1);
      if (to === index || to < 0 || to >= queue.length) return queue;
      const [moved] = queue.splice(index, 1);
      queue.splice(to, 0, moved);
      return writeQueue(sessionId, queue);
    });
  },

  peek(sessionId: string): QueuedInput | null {
    const session = agentRuntimeStore.getSession(sessionId);
    const queue = readQueue(session.sessionMetadata);
    return queue[0] ?? null;
  },

  drainNext(sessionId: string): QueuedInput | null {
    return runtimeTransaction(() => {
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      if (queue.length === 0) return null;
      const [head, ...rest] = queue;
      writeQueue(sessionId, rest);
      return head;
    });
  },

  take(sessionId: string, itemId: string): QueuedInput | null {
    return runtimeTransaction(() => {
      assertSessionExists(sessionId);
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      const index = queue.findIndex((item) => item.id === itemId);
      if (index === -1) return null;
      const [item] = queue.splice(index, 1);
      writeQueue(sessionId, queue);
      return item;
    });
  },

  getForceInjectId(sessionId: string): string | null {
    const session = agentRuntimeStore.getSession(sessionId);
    return readForceInjectId(session.sessionMetadata);
  },

  markForceInject(sessionId: string, itemId: string): QueuedInput[] {
    return runtimeTransaction(() => {
      assertSessionExists(sessionId);
      const session = agentRuntimeStore.getSession(sessionId);
      const queue = readQueue(session.sessionMetadata);
      if (!queue.some((item) => item.id === itemId)) {
        throw new AgentValidationError("Queued input not found.");
      }
      agentRuntimeStore.updateSessionMetadata(sessionId, {
        [FORCE_INJECT_METADATA_KEY]: itemId,
      });
      emitRuntimeBusEvent({
        type: "session_input_queue_changed",
        sessionId,
        patch: { forceInjectItemId: itemId },
      });
      return queue;
    });
  },

  clearForceInject(sessionId: string): void {
    return runtimeTransaction(() => {
      agentRuntimeStore.updateSessionMetadata(sessionId, {
        [FORCE_INJECT_METADATA_KEY]: null,
      });
    });
  },

  consumeForced(sessionId: string): QueuedInput | null {
    return runtimeTransaction(() => {
      const forceId = this.getForceInjectId(sessionId);
      if (!forceId) return null;
      this.clearForceInject(sessionId);
      return this.take(sessionId, forceId);
    });
  },

  consumeNext(sessionId: string): QueuedInput | null {
    return runtimeTransaction(
      () => this.consumeForced(sessionId) ?? this.drainNext(sessionId),
    );
  },

  hasPending(sessionId: string): boolean {
    const session = agentRuntimeStore.getSession(sessionId);
    const queue = readQueue(session.sessionMetadata);
    return (
      queue.length > 0 || readForceInjectId(session.sessionMetadata) !== null
    );
  },
};
