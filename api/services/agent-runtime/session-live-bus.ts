import { EventEmitter } from 'node:events';
import type { ToolCallRecord } from './contracts.js';

export type SessionLiveEvent =
  | { type: 'step_started'; stepId: string; stepIndex: number; modelCapabilities?: { reasoning: boolean } }
  | { type: 'message_delta'; stepId: string; delta: string }
  | { type: 'thought_delta'; stepId: string; delta: string }
  | { type: 'tool_call'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'tool_result'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'context_compacted'; stepId: string; originalTokens: number; compressedTokens: number; messageCount: number };

const MAX_BUFFERED_EVENTS = 2000;

class SessionLiveBus {
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly buffers = new Map<string, SessionLiveEvent[]>();

  private getOrCreate(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.emitters.set(sessionId, emitter);
    }
    return emitter;
  }

  private bufferEvent(sessionId: string, event: SessionLiveEvent): void {
    const buf = this.buffers.get(sessionId) ?? [];
    buf.push(event);
    if (buf.length > MAX_BUFFERED_EVENTS) {
      buf.splice(0, buf.length - MAX_BUFFERED_EVENTS);
    }
    this.buffers.set(sessionId, buf);
  }

  emit(sessionId: string, event: SessionLiveEvent): void {
    const emitter = this.emitters.get(sessionId);
    const listenerCount = emitter?.listenerCount('event') ?? 0;
    if (listenerCount > 0) {
      emitter!.emit('event', event);
      return;
    }
    this.bufferEvent(sessionId, event);
  }

  subscribe(sessionId: string, handler: (event: SessionLiveEvent) => void): () => void {
    const emitter = this.getOrCreate(sessionId);
    const buffered = this.buffers.get(sessionId);
    if (buffered?.length) {
      this.buffers.delete(sessionId);
      for (const event of buffered) {
        handler(event);
      }
    }
    emitter.on('event', handler);
    return () => {
      emitter.off('event', handler);
    };
  }

  cleanup(sessionId: string): void {
    this.buffers.delete(sessionId);
    const emitter = this.emitters.get(sessionId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(sessionId);
    }
  }
}

export const sessionLiveBus = new SessionLiveBus();
