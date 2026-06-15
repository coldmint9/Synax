import type { AgentRunStreamChunk, StreamTurnRequest } from '../../services/agent-runtime/contracts.js';
import { sessionLiveBus, type SessionLiveEvent } from '../../services/agent-runtime/session-live-bus.js';
import { sendToParent } from './child-forward.js';

export type AgentSessionStreamMode = 'turn' | 'continue' | 'resume';

export interface AgentSessionChildInit {
  sessionId: string;
  projectId: string;
  workDir: string;
}

export type AgentSessionParentMessage =
  | { type: 'stream:start'; streamId: string; mode: AgentSessionStreamMode; input: StreamTurnRequest }
  | { type: 'stream:cancel'; streamId: string; reason?: string }
  | { type: 'session:interrupt'; reason: string };

export type AgentSessionChildMessage =
  | { type: 'session:ready'; sessionId: string }
  | { type: 'session:live'; sessionId: string; event: SessionLiveEvent }
  | { type: 'runtime:event'; event: import('../../services/agent-runtime/runtime-bus.js').RuntimeBusEvent }
  | { type: 'stream:chunk'; sessionId: string; streamId: string; chunk: AgentRunStreamChunk }
  | { type: 'stream:done'; sessionId: string; streamId: string }
  | { type: 'stream:error'; sessionId: string; streamId: string; error: string };

export function isAgentSessionChildMessage(value: unknown): value is AgentSessionChildMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'session:ready'
    || type === 'session:live'
    || type === 'runtime:event'
    || type === 'stream:chunk'
    || type === 'stream:done'
    || type === 'stream:error';
}

export function isAgentSessionParentMessage(value: unknown): value is AgentSessionParentMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'stream:start'
    || type === 'stream:cancel'
    || type === 'session:interrupt';
}

export function sendAgentSessionToParent(message: AgentSessionChildMessage): boolean {
  if (process.env.SYNAX_AGENT_SESSION_CHILD !== '1' || typeof process.send !== 'function') {
    return false;
  }
  process.send(message);
  return true;
}

type LiveDeltaKind = 'message_delta' | 'thought_delta';

interface PendingLiveDelta {
  type: LiveDeltaKind;
  stepId: string;
  delta: string;
}

const pendingWikiLiveDeltas = new Map<string, PendingLiveDelta>();
let wikiLiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
const WIKI_LIVE_DELTA_FLUSH_MS = 50;

function flushWikiLiveDeltas(): void {
  wikiLiveFlushTimer = null;
  for (const [key, pending] of pendingWikiLiveDeltas) {
    const sessionId = key.slice(0, key.indexOf(':'));
    sendToParent({
      type: 'session:live',
      sessionId,
      event: { type: pending.type, stepId: pending.stepId, delta: pending.delta },
    });
  }
  pendingWikiLiveDeltas.clear();
}

function scheduleWikiLiveDeltaFlush(): void {
  if (wikiLiveFlushTimer) return;
  wikiLiveFlushTimer = setTimeout(flushWikiLiveDeltas, WIKI_LIVE_DELTA_FLUSH_MS);
}

function forwardSessionLiveToWikiParent(sessionId: string, event: SessionLiveEvent): void {
  if (event.type === 'message_delta' || event.type === 'thought_delta') {
    const key = `${sessionId}:${event.type}:${event.stepId}`;
    const pending = pendingWikiLiveDeltas.get(key);
    if (pending) {
      pending.delta += event.delta;
    } else {
      pendingWikiLiveDeltas.set(key, {
        type: event.type,
        stepId: event.stepId,
        delta: event.delta,
      });
    }
    scheduleWikiLiveDeltaFlush();
    return;
  }
  if (wikiLiveFlushTimer) {
    clearTimeout(wikiLiveFlushTimer);
    flushWikiLiveDeltas();
  }
  sendToParent({ type: 'session:live', sessionId, event });
}

/** Emit a live session event on the API process, or forward via IPC from a worker child. */
export function emitSessionLive(sessionId: string, event: SessionLiveEvent): void {
  if (process.env.SYNAX_AGENT_SESSION_CHILD === '1') {
    // Live SSE is derived from stream:chunk on the API process (see session-process-manager).
    return;
  }
  if (process.env.SYNAX_WIKI_JOB_CHILD === '1') {
    forwardSessionLiveToWikiParent(sessionId, event);
    return;
  }
  sessionLiveBus.emit(sessionId, event);
}

export function forwardChunkToLiveBus(sessionId: string, chunk: AgentRunStreamChunk): void {
  let event: SessionLiveEvent | null = null;
  switch (chunk.type) {
    case 'step_started':
      event = {
        type: 'step_started',
        stepId: chunk.step.id,
        stepIndex: chunk.step.index,
      };
      break;
    case 'message_delta':
      event = { type: 'message_delta', stepId: chunk.stepId, delta: chunk.delta };
      break;
    case 'thought_delta':
      event = { type: 'thought_delta', stepId: chunk.stepId, delta: chunk.delta };
      break;
    case 'tool_call':
      event = { type: 'tool_call', stepId: chunk.stepId, toolCall: chunk.toolCall };
      break;
    case 'tool_result':
      event = { type: 'tool_result', stepId: chunk.stepId, toolCall: chunk.toolCall };
      break;
    case 'context_compacted':
      event = {
        type: 'context_compacted',
        stepId: chunk.stepId,
        originalTokens: chunk.originalTokens,
        compressedTokens: chunk.compressedTokens,
        messageCount: chunk.messageCount,
      };
      break;
    default:
      break;
  }
  if (event) {
    emitSessionLive(sessionId, event);
  }
}
