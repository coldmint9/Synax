import type { SessionNotification } from '@agentclientprotocol/sdk';

class SessionUpdateRouter {
  private readonly handlers = new Map<string, (params: SessionNotification) => void>();

  set(sessionId: string, handler: (params: SessionNotification) => void): void {
    this.handlers.set(sessionId, handler);
  }

  clear(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  dispatch(sessionId: string, params: SessionNotification): void {
    this.handlers.get(sessionId)?.(params);
  }
}

export const acpSessionUpdateRouter = new SessionUpdateRouter();
