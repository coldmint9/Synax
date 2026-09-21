import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  ipcMain,
  session,
  screen,
  View,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import {
  ARTIFACT_CSP,
  ARTIFACT_SCHEME,
  MAX_ACTIVE,
  RateLimit,
  allowBundleRequest,
  assertOwner,
  clipBounds,
  fail,
  parseCreate,
  parseId,
  parseUpdate,
  safeMessage,
  validateEnvelope,
  isTrustedHostURL,
} from "./policy.js";
import { createDenyProxy } from "./network.js";
import type {
  ArtifactBounds,
  ArtifactCaptureResult,
  ArtifactElementBounds,
} from "./types.js";
import {
  boundedPng,
  MAX_CAPTURE_DIMENSION,
  parseCaptureRequest,
  parseElementBounds,
} from "./capture.js";

const ANNOTATION_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    "<!doctype html><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#2563eb}</style>",
  );
interface Instance {
  id: string;
  nonce: string;
  revisionId: string;
  url: string;
  owner: BrowserWindow;
  view: WebContentsView;
  container: View;
  session: Session;
  bounds: ArtifactBounds;
  visible: boolean;
  loaded: boolean;
  disposed: boolean;
  zoom: number;
  incoming: RateLimit;
  outgoing: RateLimit;
  pongAt: number;
  challenge: string;
  watchdog?: NodeJS.Timeout;
  layoutVersion: number;
  geometryKey: string;
  capturing?: boolean;
  capturedAt?: number;
  annotation?: ArtifactElementBounds | null;
  borders?: WebContentsView[];
  bordersReady?: Promise<void>;
  borderLoads?: Set<number>;
  handshake: "new" | "hello" | "connected";
}
const CHANNELS = [
  "create",
  "update",
  "send",
  "destroy",
  "capture",
  "annotate",
] as const;
/** No shared session, renderer evaluation, Node integration, or host credentials. */
export class ArtifactPreviewManager {
  private instances = new Map<string, Instance>();
  private owners = new Map<
    BrowserWindow,
    { used: Set<string>; cleanup: () => void }
  >();
  private registered = false;
  private proxy?: ReturnType<typeof createDenyProxy>;
  constructor(
    private readonly preload: string,
    private readonly getOwner: () => BrowserWindow | null,
    private readonly trustedURL: (url: string) => boolean = isTrustedHostURL,
  ) {}

  registerIPC(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle("artifact-preview:create", (e, input) =>
      this.create(e, input),
    );
    ipcMain.handle("artifact-preview:update", (e, input) =>
      this.update(e, input),
    );
    ipcMain.handle("artifact-preview:send", (e, input) => this.send(e, input));
    ipcMain.handle("artifact-preview:destroy", (e, id) => this.destroy(e, id));
    ipcMain.handle("artifact-preview:capture", (e, input) =>
      this.captureForHost(e, input),
    );
    ipcMain.handle("artifact-preview:annotate", (e, input) =>
      this.annotate(e, input),
    );
    ipcMain.on("artifact-runtime:message", this.onRuntimeMessage);
    ipcMain.on("artifact-runtime:pong", this.onPong);
  }
  dispose(): void {
    void this.proxy?.then((proxy) => proxy.close()).catch(() => {});
    this.proxy = undefined;
    for (const i of [...this.instances.values()]) this.remove(i);
    for (const owner of this.owners.values()) owner.cleanup();
    this.owners.clear();
    if (!this.registered) return;
    for (const name of CHANNELS)
      ipcMain.removeHandler(`artifact-preview:${name}`);
    ipcMain.removeListener("artifact-runtime:message", this.onRuntimeMessage);
    ipcMain.removeListener("artifact-runtime:pong", this.onPong);
    this.registered = false;
  }
  private authorize(event: IpcMainInvokeEvent): BrowserWindow {
    const owner = this.getOwner();
    assertOwner(event, owner);
    if (
      !owner ||
      BrowserWindow.fromWebContents(event.sender) !== owner ||
      !this.trustedURL(event.senderFrame?.url ?? "")
    )
      return fail();
    return owner;
  }
  private instance(event: IpcMainInvokeEvent, id: unknown): Instance {
    const owner = this.authorize(event);
    const i = this.instances.get(parseId(id));
    if (!i || i.owner !== owner || i.disposed)
      return fail("ARTIFACT_NOT_FOUND");
    return i;
  }
  private observeOwner(owner: BrowserWindow): Set<string> {
    const existing = this.owners.get(owner);
    if (existing) return existing.used;
    const hide = () => {
      for (const i of this.instances.values())
        if (i.owner === owner) {
          i.visible = false;
          i.layoutVersion++;
          i.container.setVisible(false);
        }
    };
    const remove = () => {
      for (const i of [...this.instances.values()])
        if (i.owner === owner) this.remove(i);
    };
    const navigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (!details.isMainFrame) return;
      if (details.isSameDocument) hide();
      else remove();
    };
    const requestLayout = () => {
      if (owner.isDestroyed() || owner.webContents.isDestroyed()) return;
      for (const i of this.instances.values())
        if (i.owner === owner && !i.disposed)
          owner.webContents.send("artifact-preview:message", {
            id: i.id,
            message: {
              protocol: 1,
              type: "transport-needs-layout",
              instanceId: i.id,
              revisionId: i.revisionId,
              nonce: i.nonce,
            },
          });
    };
    const closed = () => {
      remove();
      cleanup();
      this.owners.delete(owner);
    };
    const windowEvents = [
      "blur",
      "hide",
      "minimize",
      "resize",
      "move",
      "enter-full-screen",
      "leave-full-screen",
      "sheet-begin",
    ] as const;
    const ownerEvents: NodeJS.EventEmitter = owner;
    for (const name of windowEvents) ownerEvents.on(name, hide);
    const layoutEvents = [
      "moved",
      "focus",
      "restore",
      "enter-full-screen",
      "leave-full-screen",
    ] as const;
    for (const name of layoutEvents) ownerEvents.on(name, requestLayout);
    owner.once("closed", closed);
    owner.webContents.on("did-start-navigation", navigation);
    owner.webContents.on("render-process-gone", remove);
    owner.webContents.on("zoom-changed", hide);
    const cleanup = () => {
      for (const name of windowEvents) ownerEvents.removeListener(name, hide);
      for (const name of layoutEvents)
        ownerEvents.removeListener(name, requestLayout);
      owner.removeListener("closed", closed);
      owner.webContents.removeListener("did-start-navigation", navigation);
      owner.webContents.removeListener("render-process-gone", remove);
      owner.webContents.removeListener("zoom-changed", hide);
    };
    const used = new Set<string>();
    this.owners.set(owner, { used, cleanup });
    return used;
  }
  async create(event: IpcMainInvokeEvent, input: unknown): Promise<void> {
    const owner = this.authorize(event);
    const data = parseCreate(input);
    const used = this.observeOwner(owner);
    if (this.instances.size >= MAX_ACTIVE || used.size >= 1024)
      fail("RESOURCE_LIMIT");
    if (used.has(data.id) || this.instances.has(data.id)) fail();
    used.add(data.id);
    const token = randomUUID();
    const isolated = session.fromPartition(`synax-artifact-${token}`, {
      cache: false,
    });
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        disableDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: "user-gesture-required",
        additionalArguments: [
          `--synax-artifact=${Buffer.from(JSON.stringify({ id: data.id, nonce: data.nonce, revisionId: data.revisionId })).toString("base64")}`,
        ],
      },
    });
    const container = new View();
    container.setVisible(false);
    container.addChildView(view);
    owner.contentView.addChildView(container);
    const i: Instance = {
      id: data.id,
      nonce: data.nonce,
      revisionId: data.revisionId,
      url: `${ARTIFACT_SCHEME}://${token}/index.html`,
      owner,
      view,
      container,
      session: isolated,
      bounds: data.bounds,
      visible: false,
      loaded: false,
      disposed: false,
      zoom: owner.webContents.getZoomFactor(),
      incoming: new RateLimit(),
      outgoing: new RateLimit(),
      pongAt: Date.now(),
      challenge: "",
      layoutVersion: 0,
      geometryKey: "",
      handshake: "new",
    };
    this.instances.set(i.id, i); // Reserve the slot before the first await.
    const wc = view.webContents;
    const timeout = setTimeout(
      () => this.remove(i, "RUNTIME_UNRESPONSIVE"),
      15_000,
    );
    timeout.unref?.();
    try {
      this.installPolicy(i);
      wc.debugger.attach("1.3");
      let served = false;
      isolated.protocol.handle(ARTIFACT_SCHEME, (request) => {
        if (
          i.disposed ||
          served ||
          request.url !== i.url ||
          request.method !== "GET"
        )
          return new Response(null, { status: 403 });
        served = true;
        return new Response(data.html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": ARTIFACT_CSP,
            "X-DNS-Prefetch-Control": "off",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Permissions-Policy":
              "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), bluetooth=(), hid=(), payment=(), publickey-credentials-get=()",
          },
        });
      });
      // Defense in depth: even APIs outside webRequest cannot connect directly or resolve remote hosts.
      const proxy = await (this.proxy ??= createDenyProxy());
      if (i.disposed) fail("ARTIFACT_NOT_FOUND");
      await isolated.setProxy({
        mode: "fixed_servers",
        proxyRules: proxy.url,
        proxyBypassRules: "<-loopback>",
      });
      if (i.disposed) fail("ARTIFACT_NOT_FOUND");
      await wc.loadURL(i.url);
      if (i.disposed) fail("ARTIFACT_NOT_FOUND");
      i.loaded = true;
      wc.setZoomFactor(1);
      i.pongAt = Date.now();
      const handshakeAt = Date.now();
      i.watchdog = setInterval(() => {
        if (i.disposed) return;
        if (
          (i.handshake !== "connected" && Date.now() - handshakeAt > 5_000) ||
          Date.now() - i.pongAt > 8_000
        ) {
          this.remove(i, "RUNTIME_UNRESPONSIVE");
          return;
        }
        if (owner.webContents.getZoomFactor() !== i.zoom) {
          i.visible = false;
          i.layoutVersion++;
          container.setVisible(false);
        }
        // Keep one challenge outstanding; a stale pong cannot keep a stuck renderer alive.
        if (!i.challenge) {
          i.challenge = randomUUID();
          wc.send("artifact-runtime:ping", i.challenge);
        }
      }, 2_000);
      i.watchdog.unref?.();
    } catch (error) {
      this.remove(i);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  private installPolicy(i: Instance): void {
    const ses = i.session,
      wc = i.view.webContents;
    ses.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.on("will-download", (event, item) => {
      event.preventDefault();
      item.cancel();
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      // Exactly one constant, script-free document per host-owned border surface.
      // Generated contents cannot claim these webContents IDs or request arbitrary URLs.
      const borderLoad =
        !i.disposed &&
        details.url === ANNOTATION_URL &&
        details.method === "GET" &&
        details.resourceType === "mainFrame" &&
        details.webContentsId !== undefined &&
        i.borderLoads?.delete(details.webContentsId) === true;
      callback({
        cancel:
          !borderLoad &&
          !allowBundleRequest(details, i.url, wc.id, i.loaded || i.disposed),
      });
    });
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const events: NodeJS.EventEmitter = wc;
    for (const name of [
      "will-navigate",
      "will-frame-navigate",
      "will-redirect",
      "will-attach-webview",
    ])
      events.on(name, (event: Electron.Event) => event.preventDefault());
    wc.on("did-navigate-in-page", () => this.remove(i, "POLICY_BLOCKED"));
    wc.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
    wc.on("unresponsive", () => this.remove(i, "RUNTIME_UNRESPONSIVE"));
    wc.on("render-process-gone", () => this.remove(i, "RUNTIME_UNRESPONSIVE"));
    wc.on("destroyed", () => this.remove(i, "RUNTIME_UNRESPONSIVE"));
  }
  async update(event: IpcMainInvokeEvent, input: unknown): Promise<void> {
    this.authorize(event);
    const data = parseUpdate(input),
      i = this.instance(event, data.id);
    const version = ++i.layoutVersion;
    i.borders?.forEach((border) => border.setVisible(false));
    i.bounds = data.bounds;
    i.visible = data.visible;
    const [width, height] = i.owner.getContentSize();
    const zoom = i.owner.webContents.getZoomFactor();
    const geometry = clipBounds(i.bounds, width, height, zoom);
    const canShow = () =>
      !i.disposed &&
      version === i.layoutVersion &&
      i.loaded &&
      i.visible &&
      i.owner.isVisible() &&
      !i.owner.isMinimized() &&
      i.owner.isFocused();
    if (!geometry || !canShow()) {
      i.container.setVisible(false);
      return;
    }
    const scaleFactor = screen.getDisplayMatching(
      i.owner.getBounds(),
    ).scaleFactor;
    const geometryKey = JSON.stringify({ geometry, zoom, scaleFactor });
    if (geometryKey === i.geometryKey) {
      i.container.setVisible(true);
      this.drawAnnotation(i);
      return;
    }
    i.container.setVisible(false);
    i.geometryKey = ""; // A pending metrics change invalidates the last committed layout.
    i.zoom = zoom;
    i.container.setBounds(geometry.outer);
    // A parent View DOES NOT clip a native child on macOS. Bound the actual native
    // surface to the intersection, and crop its compositor viewport without changing
    // the document's layout viewport. Only this fixed geometry command is permitted;
    // no Runtime.evaluate, arbitrary CDP, or generated JS is accepted over IPC.
    i.view.setBounds({
      x: 0,
      y: 0,
      width: geometry.outer.width,
      height: geometry.outer.height,
    });
    try {
      await i.view.webContents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        {
          width: Math.max(1, Math.round(geometry.inner.width / zoom)),
          height: Math.max(1, Math.round(geometry.inner.height / zoom)),
          deviceScaleFactor: 0,
          mobile: false,
          // CDP viewport offsets are compositor pixels on Electron; native sizes are DIP.
          viewport: {
            x: (-geometry.inner.x / zoom) * scaleFactor,
            y: (-geometry.inner.y / zoom) * scaleFactor,
            width: geometry.outer.width / zoom,
            height: geometry.outer.height / zoom,
            scale: zoom,
          },
        },
      );
      if (canShow()) {
        i.geometryKey = geometryKey;
        i.container.setVisible(true);
        this.drawAnnotation(i);
      }
    } catch {
      if (!i.disposed) {
        this.remove(i, "POLICY_BLOCKED");
        fail();
      }
    }
  }

  async send(event: IpcMainInvokeEvent, input: unknown): Promise<void> {
    this.authorize(event);
    if (!input || typeof input !== "object") fail();
    const data = input as { id?: unknown; message?: unknown };
    const i = this.instance(event, data.id);
    const message = safeMessage(data.message);
    validateEnvelope(message, i, "host");
    if (message.type === "connect") {
      if (i.handshake !== "hello") fail();
      i.handshake = "connected";
    } else if (i.handshake !== "connected") fail();
    if (!i.outgoing.take()) fail("RESOURCE_LIMIT");
    i.view.webContents.send("artifact-runtime:message", message);
  }
  async destroy(event: IpcMainInvokeEvent, id: unknown): Promise<void> {
    const owner = this.authorize(event);
    const i = this.instances.get(parseId(id));
    if (!i) return; // Idempotent unmount, but still authorize every call.
    if (i.owner !== owner) fail();
    this.remove(i);
  }
  /** Fixed trusted-host IPC, deliberately absent from the generated-content protocol. */
  async captureForHost(
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<ArtifactCaptureResult> {
    this.authorize(event);
    const request = parseCaptureRequest(input),
      i = this.instance(event, request.id);
    if (i.revisionId !== request.revisionId || i.handshake !== "connected")
      return fail();
    if (
      i.capturing ||
      (i.capturedAt !== undefined && Date.now() - i.capturedAt < 750)
    )
      return fail("RESOURCE_LIMIT");
    const bounds = i.container.getBounds();
    const scale = screen.getDisplayMatching(i.owner.getBounds()).scaleFactor;
    if (
      bounds.width * scale > MAX_CAPTURE_DIMENSION ||
      bounds.height * scale > MAX_CAPTURE_DIMENSION
    )
      return fail("RESOURCE_LIMIT");
    const version = i.layoutVersion;
    i.capturing = true;
    i.capturedAt = Date.now();
    try {
      const image = await this.capture(i.owner, i.id);
      // No stale screenshot may escape after navigation, relayout, blur, or disposal.
      if (
        this.instance(event, request.id) !== i ||
        i.layoutVersion !== version ||
        i.revisionId !== request.revisionId ||
        !i.visible ||
        !i.container.getVisible() ||
        !i.owner.isVisible() ||
        i.owner.isMinimized() ||
        !i.owner.isFocused()
      )
        return fail();
      const bytes = image.toPNG(),
        size = boundedPng(bytes);
      return {
        ...request,
        mimeType: "image/png",
        bytes: new Uint8Array(bytes),
        ...size,
      };
    } finally {
      i.capturing = false;
    }
  }
  async annotate(event: IpcMainInvokeEvent, input: unknown): Promise<void> {
    this.authorize(event);
    const request = parseCaptureRequest(input),
      i = this.instance(event, request.id);
    if (i.revisionId !== request.revisionId || i.handshake !== "connected")
      return fail();
    i.annotation = parseElementBounds((input as { bounds?: unknown }).bounds);
    if (i.annotation) await this.ensureBorders(i);
    this.drawAnnotation(i);
  }
  private ensureBorders(i: Instance): Promise<void> {
    if (i.bordersReady) return i.bordersReady;
    // Plain View backgrounds paint below macOS native WebContentsView surfaces.
    // Use four empty, script-disabled native surfaces, never generated HTML.
    // Every strip is explicitly clipped: parent native Views do not clip on macOS.
    i.borders = Array.from({ length: 4 }, () => {
      const border = new WebContentsView({
        webPreferences: {
          session: i.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
          webSecurity: true,
          webviewTag: false,
          devTools: false,
          navigateOnDragDrop: false,
          disableDialogs: true,
          backgroundThrottling: false,
        },
      });
      border.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      border.webContents.on("will-navigate", (event) => event.preventDefault());
      border.setBackgroundColor("#2563eb");
      border.setVisible(false);
      i.container.addChildView(border);
      return border;
    });
    // A native compositor surface exists only after loading a document. This
    // constant page has no scripts, preload, protocol bridge, or external assets.
    i.borderLoads = new Set(i.borders.map((border) => border.webContents.id));
    i.bordersReady = Promise.all(
      i.borders.map((border) => border.webContents.loadURL(ANNOTATION_URL)),
    ).then(() => {});
    return i.bordersReady;
  }
  private drawAnnotation(i: Instance): void {
    i.borders?.forEach((border) => border.setVisible(false));
    const a = i.annotation;
    if (
      !a ||
      !i.container.getVisible() ||
      !i.visible ||
      i.disposed ||
      Math.abs(a.viewportWidth - i.bounds.width) > 2 ||
      Math.abs(a.viewportHeight - i.bounds.height) > 2
    )
      return;
    const [width, height] = i.owner.getContentSize();
    const g = clipBounds(i.bounds, width, height, i.zoom);
    if (!g) return;
    if (!i.borders) return;
    const x = Math.round(a.x * i.zoom + g.inner.x),
      y = Math.round(a.y * i.zoom + g.inner.y);
    const w = Math.round(a.width * i.zoom),
      h = Math.round(a.height * i.zoom),
      t = 2;
    const strips = [
      { x, y, width: w, height: Math.min(t, h) },
      { x, y: y + Math.max(0, h - t), width: w, height: Math.min(t, h) },
      { x, y, width: Math.min(t, w), height: h },
      { x: x + Math.max(0, w - t), y, width: Math.min(t, w), height: h },
    ];
    strips.forEach((r, index) => {
      const left = Math.max(0, r.x),
        top = Math.max(0, r.y);
      const right = Math.min(g.outer.width, r.x + r.width),
        bottom = Math.min(g.outer.height, r.y + r.height);
      if (right <= left || bottom <= top) return;
      i.borders![index].setBounds({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
      i.borders![index].setVisible(true);
    });
  }
  /** Main-only native capture primitive; host IPC above verifies revision and result bounds. */
  async capture(
    owner: BrowserWindow,
    id: string,
  ): Promise<Electron.NativeImage> {
    const i = this.instances.get(parseId(id));
    if (
      !i ||
      i.owner !== owner ||
      owner !== this.getOwner() ||
      i.disposed ||
      owner.isDestroyed() ||
      !owner.isVisible() ||
      owner.isMinimized() ||
      !owner.isFocused() ||
      !i.visible ||
      !i.loaded ||
      !i.container.getVisible()
    )
      return fail();
    const b = i.view.getBounds(),
      outer = i.container.getBounds();
    return i.view.webContents.capturePage({
      x: Math.max(0, -b.x),
      y: Math.max(0, -b.y),
      width: outer.width,
      height: outer.height,
    });
  }
  private findRuntime(event: Electron.IpcMainEvent): Instance | undefined {
    return [...this.instances.values()].find(
      (i) =>
        !i.disposed &&
        event.sender === i.view.webContents &&
        event.senderFrame === i.view.webContents.mainFrame &&
        event.senderFrame?.url === i.url,
    );
  }
  private onRuntimeMessage = (
    event: Electron.IpcMainEvent,
    input: unknown,
  ): void => {
    const i = this.findRuntime(event);
    if (!i) return;
    try {
      const message = safeMessage(input);
      validateEnvelope(message, i, "runtime");
      if (message.type === "hello") {
        if (i.handshake !== "new") fail();
        i.handshake = "hello";
      } else if (i.handshake !== "connected") fail();
      if (!i.incoming.take()) fail("RESOURCE_LIMIT");
      if (!i.owner.isDestroyed() && !i.owner.webContents.isDestroyed())
        i.owner.webContents.send("artifact-preview:message", {
          id: i.id,
          message,
        });
    } catch {
      this.remove(i, "POLICY_BLOCKED");
    }
  };
  private onPong = (event: Electron.IpcMainEvent, challenge: unknown): void => {
    const i = this.findRuntime(event);
    if (i && i.challenge && challenge === i.challenge) {
      i.pongAt = Date.now();
      i.challenge = "";
    }
  };
  private remove(i: Instance, code?: string): void {
    if (i.disposed) return;
    i.disposed = true;
    this.instances.delete(i.id);
    clearInterval(i.watchdog);
    i.container.setVisible(false);
    if (!i.owner.isDestroyed())
      i.owner.contentView.removeChildView(i.container);
    i.borders?.forEach((border) => {
      i.container.removeChildView(border);
      if (!border.webContents.isDestroyed())
        border.webContents.close({ waitForBeforeUnload: false });
    });
    i.container.removeChildView(i.view);
    if (!i.view.webContents.isDestroyed()) {
      if (i.view.webContents.debugger.isAttached())
        i.view.webContents.debugger.detach();
      i.view.webContents.close({ waitForBeforeUnload: false });
    }
    i.session.protocol.unhandle(ARTIFACT_SCHEME);
    // Partitions have app lifetime in Electron. Do not retain the disposed instance
    // through its session's request callback; keep the partition permanently sealed.
    i.session.webRequest.onBeforeRequest((_details, callback) =>
      callback({ cancel: true }),
    );
    void i.session.closeAllConnections().catch(() => {});
    void i.session.clearStorageData().catch(() => {});
    if (code && !i.owner.isDestroyed() && !i.owner.webContents.isDestroyed())
      i.owner.webContents.send("artifact-preview:message", {
        id: i.id,
        message: {
          protocol: 1,
          type: "transport-error",
          code,
          payload: { code },
          instanceId: i.id,
          revisionId: i.revisionId,
          nonce: i.nonce,
        },
      });
  }
}
