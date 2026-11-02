// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useSessionLifecycle } from "../useSessionLifecycle";
import type { SessionLifecycleSnapshot } from "../sessionLifecycle";

const snapshot = (
  overrides: Partial<SessionLifecycleSnapshot> = {},
): SessionLifecycleSnapshot => ({
  activeTurn: true,
  stepId: "step-1",
  hasReplyText: false,
  hasToolCall: false,
  ...overrides,
});

function setup(initial: SessionLifecycleSnapshot, scope = "p1:s1") {
  const onTransition = vi.fn();
  const hook = renderHook(
    ({ activity, scope: current }: { activity: SessionLifecycleSnapshot; scope: string }) =>
      useSessionLifecycle(current, activity, onTransition),
    { initialProps: { activity: initial, scope } },
  );
  return { onTransition, ...hook };
}

it("never reports the snapshot the feature mounted on", () => {
  const { onTransition, result } = setup(snapshot({ hasReplyText: true }));
  expect(onTransition).not.toHaveBeenCalled();
  expect(result.current).toBe("replying");
});

it("reports each lifecycle transition exactly once", () => {
  const { onTransition, result, rerender } = setup(snapshot());

  rerender({ activity: snapshot({ hasReplyText: true }), scope: "p1:s1" });
  expect(onTransition).toHaveBeenLastCalledWith("reply_started");
  expect(result.current).toBe("replying");

  rerender({
    activity: snapshot({ hasReplyText: true, hasToolCall: true }),
    scope: "p1:s1",
  });
  expect(onTransition).toHaveBeenLastCalledWith("reply_cancelled");
  expect(result.current).toBe("working");

  rerender({ activity: snapshot({ activeTurn: false }), scope: "p1:s1" });
  expect(onTransition).toHaveBeenLastCalledWith("turn_settled");
  expect(result.current).toBe("settled");
  expect(onTransition).toHaveBeenCalledTimes(3);
});

it("drops the previous scope instead of reporting a cross-session transition", () => {
  const { onTransition, result, rerender } = setup(
    snapshot({ hasReplyText: true }),
  );

  rerender({ activity: snapshot({ activeTurn: false }), scope: "p1:s2" });

  expect(onTransition).not.toHaveBeenCalled();
  expect(result.current).toBe("idle");
});

it("keeps the settled phase while later snapshots stay idle", () => {
  const { onTransition, result, rerender } = setup(snapshot());
  act(() => {
    rerender({ activity: snapshot({ activeTurn: false }), scope: "p1:s1" });
  });
  expect(result.current).toBe("settled");

  rerender({ activity: snapshot({ activeTurn: false }), scope: "p1:s1" });
  expect(result.current).toBe("settled");
  expect(onTransition).toHaveBeenCalledTimes(1);
});
