import { describe, expect, it, vi } from "vitest";
import { SessionLiveBus, sessionLiveBus } from "../session-live-bus.js";

describe("sessionLiveBus", () => {
  it("buffers events until the first subscriber connects", () => {
    const sessionId = "sess-buffer-test";
    sessionLiveBus.cleanup(sessionId);

    sessionLiveBus.emit(sessionId, {
      type: "thought_delta",
      stepId: "step-1",
      delta: "hello",
    });
    sessionLiveBus.emit(sessionId, {
      type: "thought_delta",
      stepId: "step-1",
      delta: " world",
    });

    const received: string[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      if (event.type === "thought_delta") received.push(event.delta);
    });

    expect(received).toEqual(["hello", " world"]);

    sessionLiveBus.emit(sessionId, {
      type: "thought_delta",
      stepId: "step-1",
      delta: "!",
    });
    expect(received).toEqual(["hello", " world", "!"]);

    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });

  it("delivers live events directly when subscribers are present", () => {
    const sessionId = "sess-live-test";
    sessionLiveBus.cleanup(sessionId);

    const received: string[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      if (event.type === "message_delta") received.push(event.delta);
    });

    sessionLiveBus.emit(sessionId, {
      type: "message_delta",
      stepId: "step-1",
      delta: "live",
    });
    expect(received).toEqual(["live"]);

    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });

  it('does not lose reentrant emits between replay and live registration', () => {
    const bus = new SessionLiveBus();
    bus.emit('s', { type: 'message_delta', stepId: 'step', delta: 'first' });
    bus.emit('s', { type: 'message_delta', stepId: 'step', delta: 'second' });
    const received: string[] = [];
    const unsubscribe = bus.subscribe('s', event => {
      if (event.type !== 'message_delta') return;
      received.push(event.delta);
      if (event.delta === 'first') bus.emit('s', { type: 'message_delta', stepId: 'step', delta: 'third' });
    });
    expect(received).toEqual(['first', 'second', 'third']);
    unsubscribe();
    expect(bus.diagnostics()).toEqual({ sessions: 0, listeners: 0, bufferedSessions: 0, bufferedBytes: 0, expiryTimers: 0 });
  });

  it('bounds abandoned sessions by bytes and expires them without a permanent polling timer', () => {
    vi.useFakeTimers();
    try {
      const bus = new SessionLiveBus();
      for (let i = 0; i < 200; i++) bus.emit(`s${i}`, { type: 'message_delta', stepId: 'step', delta: 'x'.repeat(128 * 1024) });
      expect(bus.diagnostics().bufferedSessions).toBeLessThanOrEqual(128);
      expect(bus.diagnostics().bufferedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(bus.diagnostics().expiryTimers).toBe(1);
      vi.advanceTimersByTime(60_001);
      expect(bus.diagnostics()).toEqual({ sessions: 0, listeners: 0, bufferedSessions: 0, bufferedBytes: 0, expiryTimers: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('coalesces task state and ignores older buffered revisions', () => {
    const bus = new SessionLiveBus();
    const state = (eventSeq: number) => ({ type: 'conversation_git_state' as const, taskId: 'task', taskRevision: 1, mrVersion: 1, status: 'conflicted' as const, eventSeq });
    for (let i = 0; i < 1000; i++) bus.emit('s', state(i));
    bus.emit('s', state(1));
    const received = vi.fn();
    const unsubscribe = bus.subscribe('s', received);
    expect(received).toHaveBeenCalledExactlyOnceWith(state(999));
    unsubscribe();
    expect(bus.diagnostics().bufferedBytes).toBe(0);
  });

  it('does not let a broken observer abort domain work or other subscribers', () => {
    const bus = new SessionLiveBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsubscribeA = bus.subscribe('s', () => { throw new Error('renderer failed'); });
    const received = vi.fn();
    const unsubscribeB = bus.subscribe('s', received);
    try {
      expect(() => bus.emit('s', { type: 'message_delta', stepId: 'step', delta: 'new' })).not.toThrow();
      expect(received).toHaveBeenCalledOnce();
    } finally { unsubscribeA(); unsubscribeB(); warning.mockRestore(); }
  });
});
