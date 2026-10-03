import type { AgentSession } from './contracts.js';
import { agentRuntimeStore as store } from './session-store.js';
import { inferSynaxSessionMode } from './synax/synax-session-mode.js';

/** The root's selected workflow is authoritative, including for delegated work. */
export function controlRoot(session: AgentSession): AgentSession {
  const seen = new Set<string>();
  let root = session;
  while (root.parentSessionId) {
    if (seen.has(root.id)) throw new Error('Cyclic session parent.');
    seen.add(root.id);
    root = store.getSession(root.parentSessionId);
  }
  return root;
}

export function workflowMode(session: AgentSession) {
  return inferSynaxSessionMode(controlRoot(session));
}

export function usesGoalWorkflow(session: AgentSession): boolean {
  return workflowMode(session) === 'goal';
}
