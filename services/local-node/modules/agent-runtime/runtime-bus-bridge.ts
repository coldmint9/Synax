import { sendAgentSessionToParent } from '../../infrastructure/runtime/ipc/agent-session-protocol.js';
import { sendToParent } from '../../infrastructure/runtime/ipc/child-forward.js';
import { runtimeBus, type RuntimeBusEvent } from './runtime-bus.js';

/** Emit a runtime bus event on the API process, or forward via IPC from a worker child. */
export function emitRuntimeBusEvent(event: RuntimeBusEvent): void {
  if (process.env.SYNAX_WIKI_JOB_CHILD === '1') {
    sendToParent({ type: 'runtime:event', event });
    return;
  }
  if (process.env.SYNAX_AGENT_SESSION_CHILD === '1') {
    sendAgentSessionToParent({ type: 'runtime:event', event });
    return;
  }
  runtimeBus.emit(event);
}
