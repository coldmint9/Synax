import { sendAgentSessionToParent } from '../../infrastructure/runtime/ipc/agent-session-protocol.js';
import { runtimeBus, type RuntimeBusEvent } from './runtime-bus.js';

let workerNotifier: ((event: RuntimeBusEvent) => void) | undefined;
/** Installed once by the process-manager composition root; no dynamic import cycle. */
export function setRuntimeWorkerNotifier(notify: (event: RuntimeBusEvent) => void): void {
  workerNotifier = notify;
}

/** Emit a runtime bus event on the API process, or forward via IPC from a worker child. */
export function emitRuntimeBusEvent(event: RuntimeBusEvent): void {
  // Local waiters also live inside agent workers. Forwarding alone would leave
  // them asleep until a polling fallback, even though this process owns state.
  runtimeBus.emit(event);
  if (process.env.SYNAX_AGENT_SESSION_CHILD === '1') {
    sendAgentSessionToParent({ type: 'runtime:event', event });
  } else if (event.type === 'subagent_state_changed') {
    workerNotifier?.(event);
  }
}
