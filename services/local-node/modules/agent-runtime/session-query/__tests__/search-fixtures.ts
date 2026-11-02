import type { AgentRuntimeMessage, AgentSession } from '../../contracts.js';

/** Minimal projection rows: search only reads identity, label, prompt and time. */
export function searchSession(
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: 's1',
    projectId: 'p1',
    profileId: 'synax',
    prompt: '帮我重构会话列表',
    title: '重构会话列表',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    parentSessionId: null,
    ...overrides,
  } as unknown as AgentSession;
}

export function searchMessage(
  id: string,
  role: AgentRuntimeMessage['role'],
  content: string,
  createdAt: string,
  overrides: Partial<AgentRuntimeMessage> = {},
): AgentRuntimeMessage {
  return {
    id,
    sessionId: 's1',
    runId: null,
    stepId: null,
    role,
    content,
    metadata: {},
    createdAt,
    ...overrides,
  } as AgentRuntimeMessage;
}
