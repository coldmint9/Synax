import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAgentPermissionNotifier } from "../useAgentPermissionNotifier";
import { useNotificationStore } from "../../react/state/notificationStore";

const bus = vi.hoisted(() => ({ changed: (_event: MessageEvent) => {} }));
vi.mock("../../lib/api/runtimeEventBus", () => ({
  subscribe: (options: {
    events: { session_changed: (event: MessageEvent) => void };
  }) => {
    bus.changed = options.events.session_changed;
    return () => {};
  },
}));
beforeEach(() => useNotificationStore.getState().clearAll());
const notify = (sessionId: string, status = "waiting_permission") =>
  act(() =>
    bus.changed({
      data: JSON.stringify({
        sessionId,
        patch: { status, pendingResumeToken: "p1" },
      }),
    } as MessageEvent),
  );

it("only toasts other sessions, clears on navigation, and allows later approvals to notify", () => {
  const navigate = vi.fn();
  const hook = renderHook(
    ({ current }) => useAgentPermissionNotifier("project", navigate, current),
    { initialProps: { current: "one" as string | null } },
  );
  notify("one");
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
  notify("two");
  notify("two");
  expect(useNotificationStore.getState().notifications).toHaveLength(1);
  hook.rerender({ current: "two" });
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
  hook.rerender({ current: null });
  notify("two");
  notify("two", "running");
  notify("two");
  expect(useNotificationStore.getState().notifications).toHaveLength(1);
  act(() =>
    useNotificationStore.getState().notifications[0].actions![0].onClick(),
  );
  expect(navigate).toHaveBeenCalledWith("two");
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
});
