import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_NOTIFICATION_MESSAGE,
  SESSION_NOTIFICATION_SETTINGS_MESSAGE,
  SessionNotificationBridge,
} from "./session-notification-bridge";

const payload = {
  id: "s1:completed:t1",
  projectId: "p1",
  sessionId: "s1",
  kind: "completed",
  title: "校验发票规则",
  body: "会话已完成\n修改完成，测试通过。",
};
let send: ReturnType<typeof vi.fn>;
let show: ReturnType<typeof vi.fn>;
let bridge: SessionNotificationBridge;
beforeEach(() => {
  send = vi.fn(() => true);
  show = vi.fn(() => true);
  bridge = new SessionNotificationBridge(send, { show });
});

describe("session notification ownership", () => {
  it("hands delivery to the runtime only while no renderer is alive", () => {
    bridge.configure({ enabled: true, locale: "zh", rendererReady: true });
    expect(send).toHaveBeenLastCalledWith({
      type: SESSION_NOTIFICATION_SETTINGS_MESSAGE,
      desktop: false,
      locale: "zh",
    });
    // A closed window keeps the app running; the runtime takes over.
    bridge.configure({ rendererReady: false });
    expect(send).toHaveBeenLastCalledWith({
      type: SESSION_NOTIFICATION_SETTINGS_MESSAGE,
      desktop: true,
      locale: "zh",
    });
    // Turning notifications off stops background delivery as well.
    bridge.configure({ enabled: false });
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ desktop: false }),
    );
  });

  it("delivers runtime notices only while it owns them", () => {
    expect(
      bridge.receive({ type: SESSION_NOTIFICATION_MESSAGE, payload }),
    ).toBe(false);
    bridge.configure({ enabled: true, rendererReady: false });
    expect(
      bridge.receive({ type: SESSION_NOTIFICATION_MESSAGE, payload }),
    ).toBe(true);
    expect(show).toHaveBeenCalledExactlyOnceWith(payload);
    // The window came back: a message still in flight must not double-notify.
    bridge.configure({ rendererReady: true });
    expect(
      bridge.receive({ type: SESSION_NOTIFICATION_MESSAGE, payload }),
    ).toBe(false);
    expect(show).toHaveBeenCalledOnce();
  });

  it("ignores unrelated and malformed runtime messages", () => {
    bridge.configure({ enabled: true, rendererReady: false });
    for (const message of [
      null,
      "text",
      { type: "synax:cua-connection", connection: null },
      { type: SESSION_NOTIFICATION_MESSAGE },
    ])
      expect(bridge.receive(message)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("keeps the last locale when a renderer reports an unsupported one", () => {
    bridge.configure({ enabled: true, locale: "en" });
    bridge.configure({ locale: "fr" });
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ locale: "en" }),
    );
  });

  it("republishes ownership after a runtime restart", () => {
    bridge.configure({ enabled: true, locale: "en", rendererReady: false });
    send.mockClear();
    bridge.publish();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: SESSION_NOTIFICATION_SETTINGS_MESSAGE,
      desktop: true,
      locale: "en",
    });
  });
});
