import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ supported: true, notices: [] as any[] }));
vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return mocks.supported;
    }
    show = vi.fn();
    close = vi.fn();
    constructor(public options: any) {
      super();
      mocks.notices.push(this);
    }
  },
}));
import {
  SessionNotifications,
  isTrustedNotificationSender,
} from "./session-notifications";
const payload = {
  id: "event-1",
  projectId: "p1",
  sessionId: "s1",
  kind: "completed",
  title: "Build a feature",
  body: "Session completed",
};
const win = () => ({
  isDestroyed: () => false,
  isFocused: () => false,
  isVisible: () => true,
  isMinimized: () => true,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn(), mainFrame: {}, isDestroyed: () => false },
});
beforeEach(() => {
  mocks.notices.length = 0;
  mocks.supported = true;
});
describe("native session notifications", () => {
  it("respects the preference and native support, and suppresses focused windows", () => {
    const window = win();
    const service = new SessionNotifications(
      () => window as any,
      async () => window as any,
      "/icon.png",
    );
    expect(service.show(payload)).toBe(false);
    service.setEnabled(true);
    mocks.supported = false;
    expect(service.show(payload)).toBe(false);
    mocks.supported = true;
    window.isFocused = () => true;
    window.isMinimized = () => false;
    expect(service.show(payload)).toBe(false);
    expect(mocks.notices).toHaveLength(0);
  });
  it("deduplicates events, restores/focuses the window, and queues navigation until the renderer is ready", async () => {
    const window = win();
    const service = new SessionNotifications(
      () => window as any,
      async () => window as any,
      "/icon.png",
    );
    service.setEnabled(true);
    expect(service.show(payload)).toBe(true);
    expect(mocks.notices[0].options).toMatchObject(
      process.platform === "darwin"
        ? { actions: [{ type: "button", text: "回复" }] }
        : { icon: "/icon.png" },
    );
    expect(mocks.notices[0].options).not.toHaveProperty(
      process.platform === "darwin" ? "icon" : "actions",
    );
    expect(service.show(payload)).toBe(false);
    mocks.notices[0].emit("click");
    await Promise.resolve();
    await Promise.resolve();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).not.toHaveBeenCalled();
    service.setRendererReady(true);
    expect(window.webContents.send).toHaveBeenCalledWith(
      "notifications:open-session",
      { projectId: "p1", sessionId: "s1", kind: "completed" },
    );
  });
  it("opens the session from the macOS reply button without a duplicate icon", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const window = win();
      const service = new SessionNotifications(
        () => window as any,
        async () => window as any,
        "/icon.png",
      );
      service.setEnabled(true);
      service.setRendererReady(true);
      expect(service.show(payload)).toBe(true);
      expect(mocks.notices[0].options).toMatchObject({
        actions: [{ type: "button", text: "回复" }],
      });
      expect(mocks.notices[0].options).not.toHaveProperty("icon");
      mocks.notices[0].emit("action", {}, 0);
      await Promise.resolve();
      expect(window.focus).toHaveBeenCalledOnce();
      expect(window.webContents.send).toHaveBeenCalledWith(
        "notifications:open-session",
        { projectId: "p1", sessionId: "s1", kind: "completed" },
      );
    } finally {
      platform.mockRestore();
    }
  });
  it("closes stale notifications on resume or opt-out and never accepts arbitrary paths", () => {
    const window = win();
    const service = new SessionNotifications(
      () => window as any,
      async () => window as any,
      "/icon.png",
    );
    service.setEnabled(true);
    service.show(payload);
    service.dismiss("s1");
    expect(mocks.notices[0].close).toHaveBeenCalledOnce();
    expect(
      service.show({ ...payload, id: "bad", projectId: "../../outside" }),
    ).toBe(false);
    service.show({ ...payload, id: "event-2" });
    service.setEnabled(false);
    expect(mocks.notices[1].close).toHaveBeenCalledOnce();
  });
  it("replaces the same session's older notice and handles native delivery failures", () => {
    const window = win();
    const service = new SessionNotifications(
      () => window as any,
      async () => window as any,
      "/icon.png",
    );
    service.setEnabled(true);
    service.show(payload);
    service.show({ ...payload, id: "event-2", kind: "input" });
    expect(mocks.notices[0].close).toHaveBeenCalledOnce();
    expect(() =>
      mocks.notices[1].emit("failed", {}, "OS rejected notification"),
    ).not.toThrow();
  });
  it("reopens a closed macOS-style window before delivering a retained notification click", async () => {
    const first = win(),
      reopened = win();
    let current: ReturnType<typeof win> | null = first;
    const ensure = vi.fn(async () => {
      current = reopened;
      return reopened as any;
    });
    const service = new SessionNotifications(
      () => current as any,
      ensure,
      "/icon.png",
    );
    service.setEnabled(true);
    service.show(payload);
    current = null;
    mocks.notices[0].emit("click");
    await Promise.resolve();
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledOnce();
    expect(reopened.focus).toHaveBeenCalledOnce();
    service.setRendererReady(true);
    expect(reopened.webContents.send).toHaveBeenCalledWith(
      "notifications:open-session",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("does not open a notification dismissed because the session resumed or the preference changed", () => {
    const window = win();
    const service = new SessionNotifications(
      () => window as any,
      async () => window as any,
      "/icon.png",
    );
    service.setEnabled(true);
    service.setRendererReady(true);
    service.show(payload);
    service.dismiss("s1");
    mocks.notices[0].emit("click");
    expect(window.focus).not.toHaveBeenCalled();
    service.show({ ...payload, id: "next" });
    service.setEnabled(false);
    mocks.notices[1].emit("click");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("accepts only the main window's top-level app or exact development origin", () => {
    const window = win();
    const event = {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    };
    Object.assign(event.senderFrame, { url: "app://./index.html" });
    expect(
      isTrustedNotificationSender(event as any, window as any, false, "5173"),
    ).toBe(true);
    Object.assign(event.senderFrame, {
      url: "http://localhost:5173/projects/p1/sessions",
    });
    expect(
      isTrustedNotificationSender(event as any, window as any, true, "5173"),
    ).toBe(true);
    expect(
      isTrustedNotificationSender(event as any, window as any, false, "5173"),
    ).toBe(false);
    expect(
      isTrustedNotificationSender(
        { ...event, senderFrame: { url: "http://localhost:5173/" } } as any,
        window as any,
        true,
        "5173",
      ),
    ).toBe(false);
    Object.assign(event.senderFrame, {
      url: "http://localhost:5173.evil.test/",
    });
    expect(
      isTrustedNotificationSender(event as any, window as any, true, "5173"),
    ).toBe(false);
  });
});
