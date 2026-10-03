import type {
  TaskLifecycleNotificationEvent,
  TaskNotificationEvent,
} from '../../../modules/notifications/task-notification-bus.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from '../../../modules/agent-runtime/contracts.js';
import type { SessionLiveEvent } from '../../../modules/agent-runtime/session-live-bus.js';
import type { AgentSessionStreamMode } from './agent-session-protocol.js';

export type ChildToParentMessage =
  | { type: 'ipc:notify'; opts: Omit<TaskLifecycleNotificationEvent, 'id' | 'timestamp'> }
  | { type: 'ipc:event'; event: TaskNotificationEvent }
  | { type: 'runtime:event'; event: import('../../../modules/agent-runtime/runtime-bus.js').RuntimeBusEvent }
  | { type: 'session:live'; sessionId: string; event: SessionLiveEvent }
  | { type: 'scan:progress'; projectId?: string; message: string; pct?: number; completed?: number; total?: number }
  | { type: 'agent:request'; requestId: string; sessionId: string; mode: AgentSessionStreamMode; input: StreamTurnRequest }
  | { type: 'agent:cancel'; requestId: string; reason?: string };

export type ParentToChildMessage =
  | { type: 'agent:chunk'; requestId: string; chunk: AgentRunStreamChunk }
  | { type: 'agent:done'; requestId: string }
  | { type: 'agent:error'; requestId: string; error: string };

export function isChildToParentMessage(value: unknown): value is ChildToParentMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'ipc:notify'
    || type === 'ipc:event'
    || type === 'runtime:event'
    || type === 'session:live'
    || type === 'scan:progress'
    || type === 'agent:request'
    || type === 'agent:cancel';
}

export function isParentToChildMessage(value: unknown): value is ParentToChildMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'agent:chunk' || type === 'agent:done' || type === 'agent:error';
}
