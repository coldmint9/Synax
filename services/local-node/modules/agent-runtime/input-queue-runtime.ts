import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { queuedInputSchema, type QueuedInput, type EnqueueInputRequest, type QueuedMoveTarget } from './input-queue-service.js';
import { runtimeTransaction } from './runtime-transaction.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';
import { normalizeInput, hasInput, inputParts } from './content-parts.js';
import { bindAssets } from './media-assets.js';
import { prepareTurnReferences } from './turn-references.js';
import { AgentValidationError } from './runtime-errors.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { emitRuntimeBusEvent } from './runtime-bus-bridge.js';
import { businessStore } from '../../infrastructure/persistence/business-store.js';

const stateSchema = z.object({ items: z.array(queuedInputSchema).max(20), forceInjectItemId: z.string().nullable(), revision: z.number().int().nonnegative(), consumed: queuedInputSchema.optional(), delivery: z.object({ runId: z.string(), item: queuedInputSchema }).nullable().optional() });
export type InputQueueState = z.infer<typeof stateSchema>;
const enabled = () => runtimeFacade.streamMode() === 'authoritative';
function decode(bytes: Uint8Array): InputQueueState { return stateSchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
async function mutate(sessionId: string, operation: 'enqueue'|'remove'|'move'|'force'|'clear_force'|'consume'|'ack_consume', payload: unknown, requestId: string = randomUUID()) {
  const bytes = await runtimeFacade.queueMutation({ sessionId, operation, payload, requestId });
  if (!bytes) throw new Error('Rust queue unavailable.');
  const result = decode(bytes);
  emitRuntimeBusEvent({ type: 'session_input_queue_changed', sessionId, patch: { queueSize: result.items.length, forceInjectItemId: result.forceInjectItemId } });
  return result;
}

/** All production consumers use this async boundary. Rust owns admission, ordering and acknowledgements. */
export const inputQueueRuntime = {
  enabled,
  async snapshot(sessionId: string): Promise<InputQueueState> {

    return stateSchema.parse(await runtimeFacade.queueSnapshot(sessionId));
  },
  async list(sessionId: string): Promise<QueuedInput[]> { return (await this.snapshot(sessionId)).items; },
  async getForceInjectId(sessionId: string): Promise<string | null> { const state = await this.snapshot(sessionId); return state.delivery?.item.id ?? state.forceInjectItemId; },
  async enqueue(sessionId: string, input: EnqueueInputRequest): Promise<QueuedInput[]> {

    await runtimeFacade.ensureUiProjection(sessionId);
    input = normalizeInput(input);
    if (!hasInput(input)) throw new AgentValidationError('Input is empty.');
    await bindAssets(sessionId, inputParts(input));
    if (input.references?.some(ref => ref.kind === 'subagent')) await businessStore.refresh(['subagent-templates']);
    const item = queuedInputSchema.parse({ id: makeRuntimeId('inq'), enqueuedAt: nowIso(), message: input.message.trim(), contentParts: input.contentParts,
      model: input.model ?? null, reasoningEffort: input.reasoningEffort, references: input.references, referenceContext: prepareTurnReferences(sessionId, input.references) });
    return (await mutate(sessionId, 'enqueue', item)).items;
  },
  async remove(sessionId: string, itemId: string): Promise<QueuedInput[]> {
    return (await mutate(sessionId, 'remove', { id: itemId })).items;
  },
  async move(sessionId: string, itemId: string, target: QueuedMoveTarget): Promise<QueuedInput[]> {
    return (await mutate(sessionId, 'move', { id: itemId, ...target })).items;
  },
  async markForceInject(sessionId: string, itemId: string): Promise<QueuedInput[]> {
    return (await mutate(sessionId, 'force', { id: itemId })).items;
  },
  async clearForceInject(sessionId: string): Promise<void> {
    await mutate(sessionId, 'clear_force', null);
  },
  async withForcedInput<T>(sessionId: string, runId: string, expectedItemId: string | null, apply: (item: QueuedInput) => T): Promise<T | null> {

    const item = await this.consumeForced(sessionId, runId, expectedItemId);
    if (!item) return null;
    const result = runtimeTransaction(() => apply(item));
    await this.acknowledgeConsumption(sessionId, runId, item.id);
    return result;
  },
  async acknowledgeConsumption(sessionId: string, runId: string, itemId: string): Promise<void> {
    await mutate(sessionId, 'ack_consume', { id: itemId, runId }, `ack-inject:${runId}:${itemId}`);
  },
  async consumeForced(sessionId: string, runId: string, expectedItemId?: string | null): Promise<QueuedInput | null> {

    const state = await this.snapshot(sessionId);
    if (state.delivery) {
      if (state.delivery.runId !== runId) throw new AgentValidationError('A previous run has an unacknowledged queued input.');
      return state.delivery.item;
    }
    if (!state.forceInjectItemId || (expectedItemId !== undefined && state.forceInjectItemId !== expectedItemId)) return null;
    return (await mutate(sessionId, 'consume', { id: state.forceInjectItemId, runId }, `inject:${runId}:${state.forceInjectItemId}`)).consumed ?? null;
  },
};
