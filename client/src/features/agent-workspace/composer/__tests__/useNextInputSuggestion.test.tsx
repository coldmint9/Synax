// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  NEXT_INPUT_SUGGESTION_TIMEOUT_MS,
  useNextInputSuggestion,
} from "../useNextInputSuggestion";
import type { SessionLifecycleSnapshot } from "../../state/sessionLifecycle";

const mocks = vi.hoisted(() => ({ suggest: vi.fn(), change: vi.fn() }));
vi.mock("../../../../adapters/transport/inputSuggestion", () => ({
  suggestNextInput: mocks.suggest,
}));

const working = (
  overrides: Partial<SessionLifecycleSnapshot> = {},
): SessionLifecycleSnapshot => ({
  activeTurn: true,
  stepId: "step-1",
  hasReplyText: false,
  hasToolCall: false,
  ...overrides,
});

interface HarnessProps {
  activity: SessionLifecycleSnapshot;
  content?: string;
  enabled?: boolean;
  locked?: boolean;
}

function useHarness({
  activity,
  content = "",
  enabled = true,
  locked = false,
}: HarnessProps) {
  return useNextInputSuggestion({
    projectId: "p1",
    sessionId: "s1",
    enabled,
    locked,
    activity,
    replyText: "已经改好了",
    content,
    model: "p/model",
    backendId: "native",
    onContentChange: mocks.change,
  });
}

function setup(activity: SessionLifecycleSnapshot, content = "") {
  return renderHook((props: HarnessProps) => useHarness(props), {
    initialProps: { activity, content },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.suggest.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("starts the guess as soon as the reply phase begins", () => {
  const { rerender } = setup(working());
  expect(mocks.suggest).not.toHaveBeenCalled();

  rerender({ activity: working({ hasReplyText: true }), content: "" });

  expect(mocks.suggest).toHaveBeenCalledTimes(1);
  expect(mocks.suggest).toHaveBeenCalledWith(
    {
      sessionId: "s1",
      projectId: "p1",
      replySoFar: "已经改好了",
      model: "p/model",
      backendId: "native",
    },
    expect.anything(),
  );
});

it("holds the guess until the turn hands the composer back", async () => {
  let resolve!: (text: string | null) => void;
  mocks.suggest.mockReturnValue(new Promise((done) => (resolve = done)));
  const { result, rerender } = setup(working());

  rerender({ activity: working({ hasReplyText: true }), content: "" });
  await act(async () => resolve("运行测试"));
  expect(result.current.suggestion).toBe(null);

  rerender({ activity: working({ activeTurn: false }), content: "" });
  expect(result.current.suggestion).toBe("运行测试");
});

it("cancels the request when the user starts typing", () => {
  const { rerender } = setup(working());
  rerender({ activity: working({ hasReplyText: true }), content: "" });
  const signal = mocks.suggest.mock.calls[0][1] as AbortSignal;

  rerender({ activity: working({ hasReplyText: true }), content: "我自己写" });

  expect(signal.aborted).toBe(true);
});

it("cancels the request when the step turns out to be tool work", () => {
  const { rerender } = setup(working());
  rerender({ activity: working({ hasReplyText: true }), content: "" });
  const signal = mocks.suggest.mock.calls[0][1] as AbortSignal;

  rerender({
    activity: working({ hasReplyText: true, hasToolCall: true }),
    content: "",
  });

  expect(signal.aborted).toBe(true);
});

it("gives up on the provider after the deadline", () => {
  vi.useFakeTimers();
  const { rerender } = setup(working());
  rerender({ activity: working({ hasReplyText: true }), content: "" });
  const signal = mocks.suggest.mock.calls[0][1] as AbortSignal;

  act(() => {
    vi.advanceTimersByTime(NEXT_INPUT_SUGGESTION_TIMEOUT_MS);
  });

  expect(signal.aborted).toBe(true);
});

it("accepts the guess into the draft and clears it", async () => {
  mocks.suggest.mockResolvedValue("运行测试");
  const { result, rerender } = setup(working());
  rerender({ activity: working({ hasReplyText: true }), content: "" });
  await act(async () => {});
  rerender({ activity: working({ activeTurn: false }), content: "" });

  act(() => result.current.accept());

  expect(mocks.change).toHaveBeenCalledWith("运行测试");
});

it("starts while the turn owns the composer and reveals the guess after it settles", async () => {
  mocks.suggest.mockResolvedValue("运行测试");
  const { result, rerender } = setup(working());

  rerender({
    activity: working({ hasReplyText: true }),
    content: "",
    locked: true,
  });
  expect(mocks.suggest).toHaveBeenCalledTimes(1);
  await act(async () => {});
  expect(result.current.suggestion).toBe(null);
  expect(result.current.phase).toBe("replying");

  rerender({ activity: working({ activeTurn: false }), content: "", locked: true });
  expect(result.current.suggestion).toBe(null);

  rerender({ activity: working({ activeTurn: false }), content: "", locked: false });
  expect(result.current.suggestion).toBe("运行测试");
});

it("drops a stale guess when the next turn starts", async () => {
  mocks.suggest.mockResolvedValue("运行测试");
  const { result, rerender } = setup(working());
  rerender({ activity: working({ hasReplyText: true }), content: "" });
  await act(async () => {});
  rerender({ activity: working({ activeTurn: false }), content: "" });
  expect(result.current.suggestion).toBe("运行测试");

  // The user answered or queued a new turn: the old prediction is stale.
  rerender({ activity: working(), content: "" });

  expect(result.current.suggestion).toBe(null);
  expect(mocks.suggest).toHaveBeenCalledTimes(1);
});

it("falls back to one guess when the turn ends without a reply phase", () => {
  const { rerender } = setup(working());
  expect(mocks.suggest).not.toHaveBeenCalled();

  // No assistant text was ever observed, yet the turn handed the draft back.
  rerender({ activity: working({ activeTurn: false }), content: "" });

  expect(mocks.suggest).toHaveBeenCalledTimes(1);
});

it("never asks for a guess outside a chat session", () => {
  const { rerender } = setup(working());
  rerender({
    activity: working({ hasReplyText: true }),
    content: "",
    enabled: false,
  });
  expect(mocks.suggest).not.toHaveBeenCalled();
});
