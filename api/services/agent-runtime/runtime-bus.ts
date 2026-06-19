import { EventEmitter } from 'node:events';

export type RuntimeBusEventType =
  | 'session_changed'
  | 'session_created'
  | 'session_deleted'
  | 'session_step_completed'
  | 'session_input_queue_changed';

export interface RuntimeBusEvent {
  type: RuntimeBusEventType;
  sessionId: string;
  patch?: Record<string, unknown>;
  runId?: string;
  stepIndex?: number;
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
