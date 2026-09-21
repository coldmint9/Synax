import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopNotification } from "../useDesktopNotification";
import { useShellStore } from "../../react/state/shellStore";
import { agentRuntimeApi, type AgentSession } from "../../lib/api/agentRuntime";
import type {
  DesktopNotificationBridge,
  SessionNotificationTarget,
} from "../../lib/notifications/sessionNotifications";
const bus = vi.hoisted(() => ({
  events: {} as Record<string, (event: MessageEvent) => void>,
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../../lib/api/runtimeEventBus", () => ({
  subscribe: (options: { events: typeof bus.events }) => {
    bus.events = options.events;
    bus.subscribe();
    return bus.unsubscribe;
  },
}));
let sequence = 0,
  id = "",
  click: (target: SessionNotificationTarget) => void;
let native: DesktopNotificationBridge;
const session = (patch: Partial<AgentSession> = {}) =>
  ({
    id,
    projectId: "other-project",
    parentSessionId: null,
    status: "completed",
    title: "校验发票规则",
    completedAt: "2026-09-21T10:00:00Z",
    pendingResumeToken: null,
    resultSummary: "修改完成，测试通过。",
    blockedReason: null,
    ...patch,
  }) as AgentSession;
const changed = (patch: Record<string, unknown>, sessionId = id) =>
  act(() =>
    bus.events.session_changed({
      data: JSON.stringify({ sessionId, patch }),
    } as MessageEvent),
  );
const resolveSession = (patch: Partial<AgentSession> = {}) =>
  vi
    .mocked(agentRuntimeApi.getSession)
    .mockResolvedValue({ session: session(patch) } as never);
beforeEach(() => {
  id = `notification-test-${++sequence}`;
  bus.subscribe.mockClear();
  bus.unsubscribe.mockClear();
  native = {
    showDesktopNotification: vi.fn(async () => true),
    setDesktopNotificationsEnabled: vi.fn(),
    dismissDesktopNotification: vi.fn(),
    onDesktopNotificationOpen: vi.fn((callback) => {
      click = callback;
      return vi.fn();
    }),
  };
  Object.assign(window, { electronAPI: native });
  useShellStore.setState({
    preferences: {
      ...useShellStore.getState().preferences,
      notifications: true,
      locale: "zh",
    },
  });
  vi.spyOn(agentRuntimeApi, "getSession");
  resolveSession();
});
afterEach(() => {
  delete (window as any).electronAPI;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop session lifecycle notifications", () => {
  it("uses native delivery with the real title/summary and opens the event's project", async () => {
    const open = vi.fn();
    renderHook(() => useDesktopNotification(open));
    expect(native.setDesktopNotificationsEnabled).toHaveBeenCalledWith(true);
    changed({ status: "completed", completedAt: session().completedAt });
    await waitFor(() =>
      expect(native.showDesktopNotification).toHaveBeenCalledOnce(),
    );
    expect(native.showDesktopNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "other-project",
        sessionId: id,
        kind: "completed",
        title: "校验发票规则",
        body: "会话已完成\n修改完成，测试通过。",
      }),
    );
    act(() =>
      click({ projectId: "other-project", sessionId: id, kind: "completed" }),
    );
    expect(open).toHaveBeenCalledWith({
      projectId: "other-project",
      sessionId: id,
      kind: "completed",
    });
  });
  it.each([
    ["waiting_input", "input", "请选择接下来的方向"],
    ["waiting_permission", "approval", "需要确认命令执行"],
  ] as const)(
    "notifies %s and deduplicates lifecycle/SSE echoes",
    async (status, kind, reason) => {
      resolveSession({
        status,
        pendingResumeToken: "request-1",
        blockedReason: reason,
      });
      renderHook(() => useDesktopNotification(vi.fn()));
      changed({ status, pendingResumeToken: "request-1" });
      changed({ status, pendingResumeToken: "request-1" });
      await waitFor(() =>
        expect(native.showDesktopNotification).toHaveBeenCalledOnce(),
      );
      changed({ status });
      expect(agentRuntimeApi.getSession).toHaveBeenCalledOnce();
      expect(native.showDesktopNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          body: expect.stringContaining(reason),
        }),
      );
      changed({ status: "running", pendingResumeToken: null });
      resolveSession({
        status,
        pendingResumeToken: "request-2",
        blockedReason: reason,
      });
      changed({ status, pendingResumeToken: "request-2" });
      await waitFor(() =>
        expect(native.showDesktopNotification).toHaveBeenCalledTimes(2),
      );
    },
  );
  it("does not notify a stale completion after the same session resumes while details load", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(agentRuntimeApi.getSession).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    renderHook(() => useDesktopNotification(vi.fn()));
    changed({ status: "completed" });
    changed({ status: "running" });
    await act(async () => resolve({ session: session() }));
    expect(native.showDesktopNotification).not.toHaveBeenCalled();
  });
  it("turning notifications off cancels pending delivery and does not request Chromium permission", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    let finish!: (value: any) => void;
    vi.mocked(agentRuntimeApi.getSession).mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    renderHook(() => useDesktopNotification(vi.fn()));
    changed({ status: "completed" });
    act(() => useShellStore.getState().setNotifications(false));
    await act(async () => finish({ session: session() }));
    expect(native.setDesktopNotificationsEnabled).toHaveBeenLastCalledWith(
      false,
    );
    expect(native.showDesktopNotification).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("does not deliver or navigate after the hook unmounts or a notification is disabled", async () => {
    let finish!: (value: any) => void;
    vi.mocked(agentRuntimeApi.getSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const open = vi.fn();
    const hook = renderHook(() => useDesktopNotification(open));
    changed({ status: "completed" });
    hook.unmount();
    await act(async () => finish({ session: session() }));
    expect(native.showDesktopNotification).not.toHaveBeenCalled();
    useShellStore.getState().setNotifications(false);
    act(() =>
      click({ projectId: "other-project", sessionId: id, kind: "approval" }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("does not replay an event seen while disabled when the setting is enabled", async () => {
    useShellStore.getState().setNotifications(false);
    renderHook(() => useDesktopNotification(vi.fn()));
    changed({ status: "completed" });
    act(() => useShellStore.getState().setNotifications(true));
    changed({ status: "completed" });
    expect(agentRuntimeApi.getSession).not.toHaveBeenCalled();
  });
  it("keeps its global subscription and dedupe when navigation callbacks change", async () => {
    const first = vi.fn(),
      second = vi.fn();
    const hook = renderHook(({ open }) => useDesktopNotification(open), {
      initialProps: { open: first },
    });
    changed({ status: "completed" });
    await waitFor(() =>
      expect(native.showDesktopNotification).toHaveBeenCalledOnce(),
    );
    hook.rerender({ open: second });
    changed({ status: "completed" });
    act(() =>
      click({ projectId: "other-project", sessionId: id, kind: "completed" }),
    );
    expect(second).toHaveBeenCalledOnce();
    expect(bus.subscribe).toHaveBeenCalledOnce();
    expect(native.showDesktopNotification).toHaveBeenCalledOnce();
    hook.unmount();
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
  });
  it("suppresses background child completion noise but not pending questions", async () => {
    resolveSession({ parentSessionId: "parent" });
    renderHook(() => useDesktopNotification(vi.fn()));
    changed({ status: "completed" });
    await act(async () => {});
    expect(native.showDesktopNotification).not.toHaveBeenCalled();
    resolveSession({
      parentSessionId: "parent",
      status: "waiting_input",
      pendingResumeToken: "i1",
    });
    changed({ status: "waiting_input", pendingResumeToken: "i1" });
    await waitFor(() =>
      expect(native.showDesktopNotification).toHaveBeenCalledOnce(),
    );
  });
  it("ignores malformed events and unsafe click targets", () => {
    const open = vi.fn();
    renderHook(() => useDesktopNotification(open));
    act(() => {
      bus.events.session_changed({ data: "null" } as MessageEvent);
      bus.events.session_changed({ data: "invalid" } as MessageEvent);
      click({ projectId: "../../bad", sessionId: id, kind: "approval" });
    });
    expect(open).not.toHaveBeenCalled();
    expect(agentRuntimeApi.getSession).not.toHaveBeenCalled();
  });
  it("dismisses obsolete notices on deletion and ignores failed detail lookups", async () => {
    vi.mocked(agentRuntimeApi.getSession).mockRejectedValue(new Error("Gone"));
    renderHook(() => useDesktopNotification(vi.fn()));
    changed({ status: "completed" });
    await act(async () => {});
    expect(native.showDesktopNotification).not.toHaveBeenCalled();
    act(() =>
      bus.events.session_deleted({
        data: JSON.stringify({ sessionId: id }),
      } as MessageEvent),
    );
    expect(native.dismissDesktopNotification).toHaveBeenCalledWith(id);
  });
  it("uses a clickable browser fallback only when native delivery is absent", async () => {
    delete (window as any).electronAPI;
    const notices: any[] = [];
    class BrowserNotice {
      static permission = "granted";
      onclick?: () => void;
      onclose?: () => void;
      close = vi.fn();
      constructor(
        public title: string,
        public options: unknown,
      ) {
        notices.push(this);
      }
    }
    vi.stubGlobal("Notification", BrowserNotice);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    const open = vi.fn();
    renderHook(() => useDesktopNotification(open));
    changed({ status: "completed" });
    await waitFor(() => expect(notices).toHaveLength(1));
    notices[0].onclick();
    expect(window.focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "other-project", sessionId: id }),
    );
  });
});
