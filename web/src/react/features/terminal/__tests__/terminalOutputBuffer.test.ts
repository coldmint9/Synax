import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalOutputBuffer } from "../terminalOutputBuffer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("coalesces bursty PTY frames and acknowledges the newest rendered sequence", () => {
  const callbacks: Array<() => void> = [];
  const write = vi.fn((_data: string, callback: () => void) =>
    callbacks.push(callback),
  );
  const committed = vi.fn();
  const output = new TerminalOutputBuffer(write, committed);

  output.push("one", 1);
  output.push("two", 2);
  vi.advanceTimersByTime(4);

  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("onetwo", expect.any(Function));
  expect(committed).not.toHaveBeenCalled();

  callbacks.shift()?.();
  expect(committed).toHaveBeenCalledWith(2);
});

it("keeps one xterm write in flight and immediately drains queued output", () => {
  const callbacks: Array<() => void> = [];
  const write = vi.fn((_data: string, callback: () => void) =>
    callbacks.push(callback),
  );
  const output = new TerminalOutputBuffer(write, vi.fn());

  output.push("first", 1);
  vi.advanceTimersByTime(4);
  output.push("second", 2);
  vi.advanceTimersByTime(20);
  expect(write).toHaveBeenCalledTimes(1);

  callbacks.shift()?.();
  vi.advanceTimersByTime(0);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1][0]).toBe("second");
});

it("flushes immediately when a burst reaches the batch limit", () => {
  const write = vi.fn((_data: string, callback: () => void) => callback());
  const output = new TerminalOutputBuffer(write, vi.fn(), 4, 5);

  output.push("12", 1);
  output.push("345", 2);
  vi.advanceTimersByTime(0);

  expect(write).toHaveBeenCalledWith("12345", expect.any(Function));
});
