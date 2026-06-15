import type {
  TaskLifecycleNotificationEvent,
  TaskNotificationEvent,
} from '../../services/notifications/task-notification-bus.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from '../../services/agent-runtime/contracts.js';
import type { SessionLiveEvent } from '../../services/agent-runtime/session-live-bus.js';
import type { AgentSessionStreamMode } from './agent-session-protocol.js';

export type WikiJobKind = 'generate' | 'reinitialize';

export interface WikiJobPayload {
  kind: WikiJobKind;
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
}

export type WikiJobChildMessage =
  | { type: 'ipc:notify'; opts: Omit<TaskLifecycleNotificationEvent, 'id' | 'timestamp'> }
  | { type: 'ipc:event'; event: TaskNotificationEvent }
  | { type: 'runtime:event'; event: import('../../services/agent-runtime/runtime-bus.js').RuntimeBusEvent }
  | { type: 'session:live'; sessionId: string; event: SessionLiveEvent }
  | { type: 'scan:progress'; projectId?: string; message: string; pct?: number; completed?: number; total?: number }
  | { type: 'job:done'; projectId: string }
  | { type: 'job:error'; projectId: string; error: string };

export type WikiAgentChildToParentMessage =
  | { type: 'agent:request'; requestId: string; sessionId: string; mode: AgentSessionStreamMode; input: StreamTurnRequest }
  | { type: 'agent:cancel'; requestId: string; reason?: string };

export type WikiAgentParentToChildMessage =
  | { type: 'agent:chunk'; requestId: string; chunk: AgentRunStreamChunk }
  | { type: 'agent:done'; requestId: string }
  | { type: 'agent:error'; requestId: string; error: string };

export type WikiChildToParentMessage = WikiJobChildMessage | WikiAgentChildToParentMessage;

export function isWikiJobChildMessage(value: unknown): value is WikiJobChildMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'ipc:notify'
    || type === 'ipc:event'
    || type === 'runtime:event'
    || type === 'session:live'
    || type === 'scan:progress'
    || type === 'job:done'
    || type === 'job:error';
}

export function isWikiAgentChildToParentMessage(value: unknown): value is WikiAgentChildToParentMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'agent:request' || type === 'agent:cancel';
}

export function isWikiAgentParentToChildMessage(value: unknown): value is WikiAgentParentToChildMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'agent:chunk' || type === 'agent:done' || type === 'agent:error';
}

export function isWikiChildToParentMessage(value: unknown): value is WikiChildToParentMessage {
  return isWikiJobChildMessage(value) || isWikiAgentChildToParentMessage(value);
}
