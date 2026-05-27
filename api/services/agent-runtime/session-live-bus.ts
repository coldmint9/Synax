import { EventEmitter } from 'node:events';
import type { ToolCallRecord } from './contracts.js';

export type SessionLiveEvent =
  | { type: 'step_started'; stepId: string; stepIndex: number; modelCapabilities?: { reasoning: boolean } }
  | { type: 'message_delta'; stepId: string; delta: string }
  | { type: 'thought_delta'; stepId: string; delta: string }
  | { type: 'tool_call'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'tool_result'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'context_compacted'; stepId: string; originalTokens: number; compressedTokens: number; messageCount: number };

class SessionLiveBus {
  private readonly emitters = new Map<string, EventEmitter>();

  private getOrCreate(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.emitters.set(sessionId, emitter);
    }
    return emitter;
  }

  emit(sessionId: string, event: SessionLiveEvent): void {
    this.emitters.get(sessionId)?.emit('event', event);
  }

  subscribe(sessionId: string, handler: (event: SessionLiveEvent) => void): () => void {
    const emitter = this.getOrCreate(sessionId);
    emitter.on('event', handler);
    return () => {
      emitter.off('event', handler);
    };
  }

  cleanup(sessionId: string): void {
    const emitter = this.emitters.get(sessionId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(sessionId);
    }
  }
}

export const sessionLiveBus = new SessionLiveBus();
