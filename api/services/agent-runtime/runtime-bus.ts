import { EventEmitter } from 'node:events';

export type RuntimeBusEventType = 'session_changed' | 'session_created' | 'session_deleted';

export interface RuntimeBusEvent {
  type: RuntimeBusEventType;
  sessionId: string;
  patch?: Record<string, unknown>;
}

class RuntimeBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: RuntimeBusEvent): void {
    this.emitter.emit('change', event);
  }

  subscribe(handler: (event: RuntimeBusEvent) => void): () => void {
    this.emitter.on('change', handler);
    return () => {
      this.emitter.off('change', handler);
    };
  }
}

export const runtimeBus = new RuntimeBus();
