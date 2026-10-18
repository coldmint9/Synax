import { agentRuntimeStore } from './session-store.js';

/** Stage a synchronous execution mutation as one local change set. The caller
 * awaits flushSession at its command boundary; only Rust writes durable data. */
export function runtimeTransaction<T>(action: () => T): T {
  return agentRuntimeStore.transaction(action);
}
