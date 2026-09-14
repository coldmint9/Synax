import type { RuntimeEvent, RuntimeEventType } from './contracts.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';

export class AgentEventService {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  append(input: {
    sessionId: string;
    type: RuntimeEventType;
    summary: string;
    payload?: Record<string, unknown>;
    visibility?: RuntimeEvent['visibility'];
  }): RuntimeEvent {
    let workId: unknown;
    try { workId = this.store.getSession(input.sessionId).sessionMetadata?.activeWorkId; } catch { /* session creation event */ }
    return this.store.appendEvent({
      id: makeRuntimeId('evt'),
      sessionId: input.sessionId,
      type: input.type,
      timestamp: nowIso(),
      visibility: input.visibility ?? 'user_visible',
      summary: input.summary,
      payload: { ...(typeof workId === "string" ? { workId } : {}), ...input.payload },
    });
  }

  list(sessionId: string, after?: string): RuntimeEvent[] {
    return this.store.listEvents(sessionId, after);
  }
}

export const agentEventService = new AgentEventService();
