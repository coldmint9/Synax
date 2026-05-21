import type { AgentSession, ToolHookContext } from './contracts.js';
import { logger } from '../../lib/logger.js';

// ── Event types ──────────────────────────────────────────────────────────────

export type SessionHookEvent =
  | { type: 'session:created'; session: AgentSession }
  | { type: 'session:status_changed'; sessionId: string; from: string; to: string; patch: Record<string, unknown> }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'run:started'; sessionId: string; runId: string }
  | { type: 'run:completed'; sessionId: string; runId: string; status: string }
  | { type: 'step:before'; sessionId: string; runId: string; stepIndex: number }
  | { type: 'step:after'; sessionId: string; runId: string; stepIndex: number }
  | { type: 'tool:before'; ctx: ToolHookContext }
  | { type: 'tool:after'; ctx: ToolHookContext };

export type SessionHookEventType = SessionHookEvent['type'];

// ── Hook interface ───────────────────────────────────────────────────────────

export interface SessionHookFilter {
  sessionId?: string;
  profileId?: string;
  eventTypes?: SessionHookEventType[];
}

export interface SessionHook {
  id: string;
  filter?: SessionHookFilter;
  handler: (event: SessionHookEvent) => Promise<void> | void;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class SessionHookRegistry {
  private readonly hooks = new Map<string, SessionHook>();

  register(hook: SessionHook): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(hookId: string): void {
    this.hooks.delete(hookId);
  }

  async emit(event: SessionHookEvent): Promise<void> {
    for (const hook of this.hooks.values()) {
      if (!this.matches(hook, event)) continue;
      try {
        await hook.handler(event);
      } catch (err) {
        logger.warn({ hookId: hook.id, eventType: event.type, err },
          '[session-hooks] hook handler failed');
      }
    }
  }

  private matches(hook: SessionHook, event: SessionHookEvent): boolean {
    const f = hook.filter;
    if (!f) return true;
    if (f.eventTypes && !f.eventTypes.includes(event.type)) return false;
    if (f.sessionId) {
      const sid = 'sessionId' in event ? event.sessionId
        : 'session' in event ? event.session.id
        : 'ctx' in event ? event.ctx.sessionId
        : null;
      if (sid && sid !== f.sessionId) return false;
    }
    return true;
  }
}

export const sessionHooks = new SessionHookRegistry();
