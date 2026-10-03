export const SseEventType = {
  Connected: 'connected',
  Ping: 'ping',
  Ready: 'ready',
} as const;

export type SseEventType = (typeof SseEventType)[keyof typeof SseEventType];
