import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SWITCH_TRANSITION_MAX_WAIT_MS,
  SWITCH_TRANSITION_MIN_MS,
  useSwitchTransition,
} from "../useSwitchTransition";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Props = { id: string | null; enabled: boolean; ready: boolean };

function setup(initial: Props) {
  return renderHook(
    ({ id, enabled, ready }: Props) => useSwitchTransition(id, enabled, ready),
    { initialProps: initial },
  );
}

it("holds a switch for its minimum window once the caller reports ready", () => {
  const view = setup({ id: "a", enabled: true, ready: true });
  expect(view.result.current).toBe(false);
  view.rerender({ id: "b", enabled: true, ready: true });
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MIN_MS - 1));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(false);
});

it("keeps the switch open while history or entries are still loading", () => {
  const view = setup({ id: "a", enabled: true, ready: true });
  view.rerender({ id: "b", enabled: true, ready: false });
  expect(view.result.current).toBe(true);
  // Well past the minimum hold: the caller has not finished yet.
  act(() => vi.advanceTimersByTime(900));
  expect(view.result.current).toBe(true);
  view.rerender({ id: "b", enabled: true, ready: true });
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(false);
});

it("releases a stuck switch at the ceiling so the transcript never stays blurred", () => {
  const view = setup({ id: "a", enabled: true, ready: true });
  view.rerender({ id: "b", enabled: true, ready: false });
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MAX_WAIT_MS - 1));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(false);
});

it("does not mask the first paint, a re-selection or the new-session scene", () => {
  const view = setup({ id: "a", enabled: true, ready: true });
  view.rerender({ id: "a", enabled: true, ready: true });
  expect(view.result.current).toBe(false);
  view.rerender({ id: null, enabled: true, ready: true });
  expect(view.result.current).toBe(false);
  view.rerender({ id: "b", enabled: true, ready: true });
  expect(view.result.current).toBe(true);
});

it("stays out of the way while the transcript is inactive", () => {
  const view = setup({ id: "a", enabled: false, ready: false });
  view.rerender({ id: "b", enabled: false, ready: false });
  expect(view.result.current).toBe(false);
  // Becoming active later must not replay a switch already painted.
  view.rerender({ id: "b", enabled: true, ready: true });
  expect(view.result.current).toBe(false);
});

it("restarts the window when the reader switches again immediately", () => {
  const view = setup({ id: "a", enabled: true, ready: true });
  view.rerender({ id: "b", enabled: true, ready: true });
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MIN_MS - 20));
  view.rerender({ id: "c", enabled: true, ready: true });
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MIN_MS - 1));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(false);
});
