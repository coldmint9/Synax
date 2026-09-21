import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  sessions: [] as any[],
  views: [] as any[],
  owner: null as any,
  nextId: 10,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class View {
    children: any[] = [];
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    addChildView(v: any) {
      this.children.push(v);
    }
    removeChildView(v: any) {
      this.children = this.children.filter((c) => c !== v);
    }
    setBorderRadius(_radius: number) {}
    setBackgroundColor(_color: string) {}
    setVisible(v: boolean) {
      this.visible = v;
    }
    getVisible() {
      return this.visible;
    }
    setBounds(b: any) {
      this.bounds = b;
    }
    getBounds() {
      return this.bounds;
    }
  }
  class WebContentsView extends View {
    webContents: any;
    constructor(options: any) {
      super();
      const wc = Object.assign(new EventEmitter(), {
        debugger: {
          attach: vi.fn(),
          isAttached: () => true,
          detach: vi.fn(),
          sendCommand: vi.fn(async () => {}),
        },
        id: ++mocks.nextId,
        mainFrame: { url: "" },
        dead: false,
        loadURL: vi.fn(async (url: string) => {
          wc.mainFrame.url = url;
        }),
        isDestroyed: () => wc.dead,
        close: vi.fn(() => {
          wc.dead = true;
          wc.emit("destroyed");
        }),
        send: vi.fn(),
        setZoomFactor: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setWebRTCIPHandlingPolicy: vi.fn(),
      });
      this.webContents = wc;
      mocks.views.push({ view: this, options });
    }
  }
  const ipc = Object.assign(new EventEmitter(), {
    handle: (key: string, fn: Function) => mocks.handlers.set(key, fn),
    removeHandler: (key: string) => mocks.handlers.delete(key),
  });
  return {
    screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
    View,
    WebContentsView,
    BrowserWindow: {
      fromWebContents: (wc: any) =>
        wc === mocks.owner?.webContents ? mocks.owner : null,
    },
    ipcMain: ipc,
    session: {
      fromPartition: vi.fn((partition: string, options: any) => {
        const s = Object.assign(new EventEmitter(), {
          partition,
          options,
          protocol: { handle: vi.fn(), unhandle: vi.fn() },
          webRequest: { onBeforeRequest: vi.fn() },
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(),
          setDisplayMediaRequestHandler: vi.fn(),
          setProxy: vi.fn(async () => {}),
          closeAllConnections: vi.fn(async () => {}),
          clearStorageData: vi.fn(async () => {}),
        });
        mocks.sessions.push(s);
        return s;
      }),
    },
  };
});
import { ipcMain, View } from "electron";
import { ArtifactPreviewManager } from "./manager.js";
const create = (id = "one") => ({
  id,
  html: "<p>hello</p>",
  nonce: "n".repeat(32),
  revisionId: "revision-one",
  bounds: { x: 0, y: 0, width: 300, height: 200 },
});
describe("artifact view manager", () => {
  let manager: ArtifactPreviewManager;
  let owner: any;
  let event: any;
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.sessions.length = 0;
    mocks.views.length = 0;
    owner = Object.assign(new EventEmitter(), {
      contentView: new View(),
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => true,
      isMinimized: () => false,
      getContentSize: () => [800, 600],
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: {},
        getZoomFactor: () => 1,
        isDestroyed: () => false,
        send: vi.fn(),
      }),
    });
    mocks.owner = owner;
    event = {
      sender: owner.webContents,
      senderFrame: owner.webContents.mainFrame,
    };
    manager = new ArtifactPreviewManager(
      "/artifact-preload.js",
      () => owner,
      () => true,
    );
    manager.registerIPC();
  });
  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });
  async function connected() {
    await manager.create(event, create());
    const wc = mocks.views[0].view.webContents;
    const message = {
      protocol: 1,
      instanceId: "one",
      revisionId: create().revisionId,
      nonce: create().nonce,
    };
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      { ...message, type: "hello" },
    );
    await manager.send(event, {
      id: "one",
      message: { ...message, type: "connect" },
    });
    await manager.update(event, {
      id: "one",
      bounds: create().bounds,
      visible: true,
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
      "base64",
    );
    wc.capturePage = vi.fn(async () => ({ toPNG: () => png }));
    return { wc, png };
  }
  it("captures only the bound owner/revision, returning bounded PNG via fixed IPC", async () => {
    const { wc, png } = await connected();
    const input = { id: "one", revisionId: "revision-one" };
    const handler = mocks.handlers.get("artifact-preview:capture")!;
    await expect(handler({ ...event, sender: wc }, input)).rejects.toThrow();
    await expect(
      handler({ ...event, senderFrame: {} }, input),
    ).rejects.toThrow();
    await expect(
      handler(event, { ...input, revisionId: "other" }),
    ).rejects.toThrow();
    expect(wc.capturePage).not.toHaveBeenCalled();
    expect(await handler(event, input)).toEqual({
      ...input,
      mimeType: "image/png",
      bytes: new Uint8Array(png),
      width: 1,
      height: 1,
    });
    expect(wc.capturePage).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
    await expect(handler(event, input)).rejects.toThrow("RESOURCE_LIMIT");
  });
  it("keeps a capture valid across identical host layout notifications", async () => {
    const { wc, png } = await connected();
    let finish!: (value: unknown) => void;
    wc.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.captureForHost(event, {
      id: "one",
      revisionId: "revision-one",
    });
    await manager.update(event, {
      id: "one",
      bounds: create().bounds,
      visible: true,
    });
    finish({ toPNG: () => png });
    await expect(pending).resolves.toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
  });
  it("rejects hidden captures and rechecks disposed instance after awaiting native pixels", async () => {
    const { wc, png } = await connected();
    const input = { id: "one", revisionId: "revision-one" };
    await manager.update(event, {
      id: "one",
      bounds: create().bounds,
      visible: false,
    });
    await expect(manager.captureForHost(event, input)).rejects.toThrow();
    expect(wc.capturePage).not.toHaveBeenCalled();
    await manager.update(event, {
      id: "one",
      bounds: create().bounds,
      visible: true,
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    let finish!: (v: unknown) => void;
    wc.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.captureForHost(event, input);
    await manager.destroy(event, "one");
    finish({ toPNG: () => png });
    await expect(pending).rejects.toThrow("ARTIFACT_NOT_FOUND");
    vi.restoreAllMocks();
  });
  it("rejects oversized PNG and stale capture after relayout", async () => {
    const { wc, png } = await connected();
    const input = { id: "one", revisionId: "revision-one" };
    wc.capturePage.mockResolvedValueOnce({
      toPNG: () => Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    await expect(manager.captureForHost(event, input)).rejects.toThrow(
      "RESOURCE_LIMIT",
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    let finish!: (v: unknown) => void;
    wc.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.captureForHost(event, input);
    await manager.update(event, {
      id: "one",
      bounds: create().bounds,
      visible: false,
    });
    finish({ toPNG: () => png });
    await expect(pending).rejects.toThrow();
    vi.restoreAllMocks();
  });
  it("clips controlled native annotation strips inside the actual preview surface", async () => {
    await connected();
    await manager.update(event, {
      id: "one",
      bounds: { x: -50, y: -20, width: 300, height: 200 },
      visible: true,
    });
    await manager.annotate(event, {
      id: "one",
      revisionId: "revision-one",
      bounds: {
        x: 40,
        y: 10,
        width: 100,
        height: 60,
        viewportWidth: 300,
        viewportHeight: 200,
      },
    });
    const container = owner.contentView.children[0];
    expect(container.children).toHaveLength(5);
    const borders = mocks.views.slice(1);
    expect(borders).toHaveLength(4);
    const filter =
      mocks.sessions[0].webRequest.onBeforeRequest.mock.calls[0][0];
    for (const { view, options } of borders) {
      expect(options.webPreferences).toMatchObject({
        session: mocks.sessions[0],
        sandbox: true,
        javascript: false,
        nodeIntegration: false,
        contextIsolation: true,
      });
      expect(options.webPreferences.preload).toBeUndefined();
      const url = view.webContents.loadURL.mock.calls[0][0];
      expect(decodeURIComponent(url)).toContain("default-src 'none'");
      const request = {
        url,
        method: "GET",
        resourceType: "mainFrame",
        webContentsId: view.webContents.id,
      };
      const result = vi.fn();
      filter(
        { ...request, webContentsId: mocks.views[0].view.webContents.id },
        result,
      );
      expect(result).toHaveBeenLastCalledWith({ cancel: true });
      filter({ ...request, url: "https://example.com" }, result);
      expect(result).toHaveBeenLastCalledWith({ cancel: true });
      filter(request, result);
      expect(result).toHaveBeenLastCalledWith({ cancel: false });
      filter(request, result);
      expect(result).toHaveBeenLastCalledWith({ cancel: true });
    }
    for (const border of container.children
      .slice(1)
      .filter((v: any) => v.visible)) {
      const b = border.bounds;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(container.bounds.width);
      expect(b.y + b.height).toBeLessThanOrEqual(container.bounds.height);
    }
    await manager.annotate(event, {
      id: "one",
      revisionId: "revision-one",
      bounds: null,
    });
    expect(container.children.slice(1).every((b: any) => !b.visible)).toBe(
      true,
    );
    await expect(
      manager.annotate(event, { id: "one", revisionId: "wrong", bounds: null }),
    ).rejects.toThrow();
    await manager.destroy(event, "one");
    for (const { view } of borders)
      expect(view.webContents.close).toHaveBeenCalledOnce();
  });
  it("rejects arbitrary renderer and subframe calls before allocating a session", async () => {
    await expect(
      manager.create({ ...event, sender: {} }, create()),
    ).rejects.toThrow("POLICY_BLOCKED");
    await expect(
      manager.create({ ...event, senderFrame: {} }, create()),
    ).rejects.toThrow("POLICY_BLOCKED");
    expect(mocks.sessions).toHaveLength(0);
  });
  it("creates private ephemeral partitions and enforces a global two-view limit", async () => {
    await Promise.all([
      manager.create(event, create()),
      manager.create(event, create("two")),
    ]);
    await expect(manager.create(event, create("three"))).rejects.toThrow(
      "RESOURCE_LIMIT",
    );
    expect(mocks.sessions[0].partition).not.toBe(mocks.sessions[1].partition);
    for (const s of mocks.sessions) {
      expect(s.partition).not.toMatch(/^persist:/);
      expect(s.options.cache).toBe(false);
      expect(s.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
      expect(s.setDevicePermissionHandler.mock.calls[0][0]()).toBe(false);
      const callback = vi.fn();
      s.setPermissionRequestHandler.mock.calls[0][0](null, "camera", callback);
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(mocks.views[0].options.webPreferences).toMatchObject({
      preload: "/artifact-preload.js",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    });
  });
  it("serves exact bundle once with restrictive headers and no file lookup", async () => {
    await manager.create(event, create());
    const handler = mocks.sessions[0].protocol.handle.mock.calls[0][1];
    const url = mocks.views[0].view.webContents.mainFrame.url;
    expect(handler(new Request(url + "?escape")).status).toBe(403);
    const response = handler(new Request(url));
    expect(await response.text()).toBe(create().html);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'none'",
    );
    expect(handler(new Request(url)).status).toBe(403);
  });
  it("requires full binding and rejects stale instance reuse and messages", async () => {
    await manager.create(event, create());
    const wc = mocks.views[0].view.webContents;
    const message = {
      protocol: 1,
      instanceId: "one",
      nonce: create().nonce,
      revisionId: create().revisionId,
      type: "hello",
    };
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      message,
    );
    expect(owner.webContents.send).toHaveBeenCalledWith(
      "artifact-preview:message",
      { id: "one", message },
    );
    await expect(
      manager.send(event, {
        id: "one",
        message: { ...message, type: "connect", nonce: "wrong" },
      }),
    ).rejects.toThrow();
    await manager.destroy(event, "one");
    owner.webContents.send.mockClear();
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      message,
    );
    expect(owner.webContents.send).not.toHaveBeenCalled();
    await expect(manager.create(event, create())).rejects.toThrow();
    await expect(
      manager.update(event, {
        id: "one",
        bounds: create().bounds,
        visible: true,
      }),
    ).rejects.toThrow("ARTIFACT_NOT_FOUND");
    await manager.destroy(event, "one");
  });
  it("hides by default, crops the inner view, hides on native events and destroys on owner navigation", async () => {
    await manager.create(event, create());
    const container = owner.contentView.children[0];
    expect(container.visible).toBe(false);
    await manager.update(event, {
      id: "one",
      bounds: {
        x: -20,
        y: 20,
        width: 300,
        height: 200,
        clip: { x: 40, y: 40, width: 100, height: 80 },
      },
      visible: true,
    });
    expect(container.bounds).toEqual({ x: 40, y: 40, width: 100, height: 80 });
    expect(mocks.views[0].view.bounds).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    });
    expect(
      mocks.views[0].view.webContents.debugger.sendCommand,
    ).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({
        width: 300,
        height: 200,
        viewport: { x: 60, y: 20, width: 100, height: 80, scale: 1 },
      }),
    );
    expect(container.visible).toBe(true);
    owner.emit("blur");
    expect(container.visible).toBe(false);
    owner.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(mocks.views[0].view.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(owner.contentView.children).toHaveLength(0);
  });
  it("stops only the hung instance without relying on artifact code", async () => {
    vi.useFakeTimers();
    await manager.create(event, create());
    await manager.create(event, create("two"));
    const wc = mocks.views[0].view.webContents;
    wc.emit("unresponsive");
    expect(wc.close).toHaveBeenCalledOnce();
    expect(mocks.views[1].view.webContents.close).not.toHaveBeenCalled();
    expect(owner.webContents.send).toHaveBeenCalledWith(
      "artifact-preview:message",
      expect.objectContaining({
        id: "one",
        message: expect.objectContaining({ code: "RUNTIME_UNRESPONSIVE" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect(mocks.views[1].view.webContents.close).toHaveBeenCalledOnce();
  });

  it("does not restore an obsolete async layout over a newer hide or crop", async () => {
    await manager.create(event, create());
    const wc = mocks.views[0].view.webContents,
      container = owner.contentView.children[0];
    const initial = { id: "one", bounds: create().bounds, visible: true };
    await manager.update(event, initial);
    let finish!: () => void;
    wc.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.update(event, {
      ...initial,
      bounds: { ...initial.bounds, x: 40 },
    });
    expect(container.visible).toBe(false);
    await manager.update(event, { ...initial, visible: false });
    finish();
    await pending;
    expect(container.visible).toBe(false);
    await manager.update(event, initial);
    expect(container.bounds.x).toBe(0);
    expect(container.visible).toBe(true);
  });
  it("cleans up failed native policy setup and rejects premature/replayed handshake", async () => {
    await manager.create(event, create());
    const wc = mocks.views[0].view.webContents;
    const message = {
      protocol: 1,
      instanceId: "one",
      nonce: create().nonce,
      revisionId: create().revisionId,
      type: "connect",
    };
    await expect(manager.send(event, { id: "one", message })).rejects.toThrow();
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      { ...message, type: "hello" },
    );
    await manager.send(event, { id: "one", message });
    await expect(manager.send(event, { id: "one", message })).rejects.toThrow();
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      { ...message, type: "hello" },
    );
    expect(wc.close).toHaveBeenCalledOnce();
  });
  it("removes and stops a flooding instance; removes handlers on shutdown", async () => {
    await manager.create(event, create());
    const wc = mocks.views[0].view.webContents;
    ipcMain.emit(
      "artifact-runtime:message",
      { sender: wc, senderFrame: wc.mainFrame },
      {
        protocol: 1,
        instanceId: "one",
        revisionId: create().revisionId,
        nonce: create().nonce,
        type: "hello",
      },
    );
    await manager.send(event, {
      id: "one",
      message: {
        protocol: 1,
        instanceId: "one",
        revisionId: create().revisionId,
        nonce: create().nonce,
        type: "connect",
      },
    });
    for (let n = 0; n < 41; n++)
      ipcMain.emit(
        "artifact-runtime:message",
        { sender: wc, senderFrame: wc.mainFrame },
        {
          protocol: 1,
          instanceId: "one",
          revisionId: create().revisionId,
          nonce: create().nonce,
          type: "log",
        },
      );
    expect(wc.close).toHaveBeenCalledOnce();
    manager.dispose();
    expect(mocks.handlers.size).toBe(0);
  });
});
