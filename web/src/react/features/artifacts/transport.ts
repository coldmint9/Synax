import type { ArtifactCaptureResult, ArtifactElementBounds } from "./capture";
import {
  acceptsEnvelope,
  injectRuntimeConfig,
  MessageBudget,
  runtimeId,
  safeJson,
  type Envelope,
  type RuntimeConfig,
} from "./bridge";
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  clip?: { x: number; y: number; width: number; height: number };
}
export interface DesktopPreview {
  capture?(input: {
    id: string;
    revisionId: string;
  }): Promise<ArtifactCaptureResult>;
  annotate?(input: {
    id: string;
    revisionId: string;
    bounds: ArtifactElementBounds | null;
  }): Promise<void>;
  create(input: {
    id: string;
    html: string;
    revisionId: string;
    nonce: string;
    bounds: Bounds;
  }): Promise<unknown>;
  update(input: {
    id: string;
    bounds: Bounds;
    visible: boolean;
  }): Promise<unknown>;
  send(input: { id: string; message: unknown }): Promise<unknown>;
  destroy(id: string): Promise<unknown>;
  onMessage(
    listener: (event: { id: string; message: unknown }) => void,
  ): (() => void) | Promise<() => void>;
}
export function desktopEnvironment(): {
  desktop: boolean;
  transport?: DesktopPreview;
} {
  const api = (
    window as unknown as { electronAPI?: { artifactPreview?: DesktopPreview } }
  ).electronAPI;
  return {
    desktop:
      !!api ||
      window.location.protocol === "app:" ||
      /\bElectron\//.test(navigator.userAgent),
    transport: api?.artifactPreview,
  };
}
export interface PreviewConnection {
  capture?: () => Promise<ArtifactCaptureResult>;
  annotate?: (bounds: ArtifactElementBounds | null) => Promise<void>;
  send(type: string, payload: unknown): void;
  destroy(): void;
  update(): void;
}
export function mountPreview(options: {
  container: HTMLElement;
  html: string;
  revisionId: string;
  title: string;
  onRequest: (type: string, payload: unknown) => unknown | Promise<unknown>;
  onError: (error: Error) => void;
  onConnected: () => void;
}): PreviewConnection {
  const { container, onRequest, onError, onConnected } = options;
  const { desktop, transport } = desktopEnvironment();
  const config: RuntimeConfig = {
    protocol: 1,
    instanceId: runtimeId(),
    nonce: runtimeId(),
    revisionId: options.revisionId,
    transport: desktop ? "desktop" : "web",
  };
  const id = config.instanceId;
  let lastCaptureAt = 0;
  let capturePending = false;
  let disposed = false,
    connected = false,
    desktopCreated = false;
  let frame: HTMLIFrameElement | undefined;
  let port: MessagePort | undefined;
  let unsubscribe: (() => void) | undefined;
  let observer: MutationObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let updateFrame = 0;
  const budget = new MessageBudget();
  const seenRequests = new Set<string>();
  const timer = setTimeout(
    () =>
      fail(
        new Error("Preview did not connect within 5 seconds. Reload to retry."),
      ),
    5000,
  );
  function envelope(
    type: string,
    payload: unknown,
    requestId?: string,
  ): Envelope {
    return { ...config, type, payload, ...(requestId ? { requestId } : {}) };
  }
  function sendEnvelope(message: Envelope) {
    if (disposed) return;
    safeJson(message);
    if (desktop) void transport?.send({ id, message }).catch(fail);
    else port?.postMessage(message);
  }
  function fail(error: unknown) {
    if (disposed) return;
    destroy();
    onError(error instanceof Error ? error : new Error(String(error)));
  }
  async function receive(message: unknown) {
    if (disposed || !connected) return;
    if (!budget.take()) {
      fail(new Error("Preview paused: message rate limit exceeded."));
      return;
    }
    if (!acceptsEnvelope(message, config)) return;
    if (!message.requestId || seenRequests.has(message.requestId)) return;
    seenRequests.add(message.requestId);
    // Bound dedup memory. Ports and nonces are revoked at teardown.
    if (seenRequests.size > 200)
      seenRequests.delete(seenRequests.values().next().value!);
    try {
      const result = await onRequest(message.type, message.payload);
      sendEnvelope(
        envelope(
          "response",
          { result: result === undefined ? null : result },
          message.requestId,
        ),
      );
    } catch (error) {
      sendEnvelope(
        envelope(
          "response",
          {
            error:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : "Artifact request rejected.",
          },
          message.requestId,
        ),
      );
    }
  }
  function markConnected() {
    connected = true;
    clearTimeout(timer);
    onConnected();
  }
  function onWindow(event: MessageEvent) {
    if (
      disposed ||
      connected ||
      !frame?.contentWindow ||
      !acceptsEnvelope(event.data, config, event.source, frame.contentWindow) ||
      event.data.type !== "hello"
    )
      return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e) => void receive(e.data);
    port.start();
    frame.contentWindow.postMessage(envelope("connect", {}), "*", [
      channel.port2,
    ]);
    markConnected();
  }
  function bounds(): { bounds: Bounds; visible: boolean } {
    const rect = container.getBoundingClientRect();
    let left = 0,
      top = 0,
      right = window.innerWidth,
      bottom = window.innerHeight;
    let hidden = false;
    for (let node = container.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      )
        hidden = true;
      if (
        /auto|scroll|hidden|clip/.test(
          `${style.overflow} ${style.overflowX} ${style.overflowY}`,
        )
      ) {
        const clip = node.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    // The desktop container clips without resizing/reflowing the generated page.
    const occluded = !!document.querySelector(
      '[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], [data-artifact-overlay="true"], [data-slot="popover-content"]',
    );
    const visible =
      !document.hidden &&
      !hidden &&
      !occluded &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.bottom > top &&
      rect.left < right &&
      rect.top < bottom;
    return {
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        clip: {
          x: Math.max(0, Math.ceil(left)),
          y: Math.max(0, Math.ceil(top)),
          width: Math.max(0, Math.floor(right) - Math.ceil(left)),
          height: Math.max(0, Math.floor(bottom) - Math.ceil(top)),
        },
      },
      visible,
    };
  }
  function update() {
    if (!desktop || !desktopCreated || disposed || updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      if (!disposed) void transport?.update({ id, ...bounds() }).catch(fail);
    });
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    cancelAnimationFrame(updateFrame);
    window.removeEventListener("message", onWindow);
    window.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update);
    window.removeEventListener("focus", update);
    document.removeEventListener("visibilitychange", update);
    observer?.disconnect();
    resizeObserver?.disconnect();
    unsubscribe?.();
    port?.close();
    frame?.remove();
    if (desktop && transport) void transport.destroy(id).catch(() => {});
  }
  try {
    const html = injectRuntimeConfig(options.html, config);
    if (desktop) {
      if (!transport)
        throw new Error(
          "Dedicated desktop preview transport is unavailable. No Web fallback was started.",
        );
      void (async () => {
        unsubscribe = await transport.onMessage((event) => {
          if (
            disposed ||
            event.id !== id ||
            !acceptsEnvelope(event.message, config)
          )
            return;
          const message = event.message as Envelope;
          if (message.type === "transport-needs-layout") {
            update();
          } else if (message.type === "hello" && !connected) {
            sendEnvelope(envelope("connect", {}));
            markConnected();
          } else if (
            message.type === "error" ||
            message.type === "transport-error"
          )
            fail(new Error("Dedicated desktop preview stopped unexpectedly."));
          else void receive(message);
        });
        if (disposed) {
          unsubscribe();
          return;
        }
        await transport.create({
          id,
          html,
          revisionId: options.revisionId,
          nonce: config.nonce,
          bounds: bounds().bounds,
        });
        if (disposed) {
          await transport.destroy(id);
          return;
        }
        desktopCreated = true;
        update();
      })().catch(fail);
      window.addEventListener("scroll", update, true);
      window.addEventListener("resize", update);
      window.addEventListener("focus", update);
      document.addEventListener("visibilitychange", update);
      observer = new MutationObserver(update);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "aria-modal", "hidden"],
      });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(container);
      }
    } else {
      frame = document.createElement("iframe");
      frame.title = options.title;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute(
        "allow",
        "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
      );
      frame.className = "artifact-preview-frame";
      window.addEventListener("message", onWindow);
      frame.srcdoc = html;
      container.append(frame);
    }
  } catch (error) {
    queueMicrotask(() => fail(error));
  }
  return {
    ...(desktop && transport?.capture
      ? {
          capture: async () => {
            if (disposed || !connected)
              throw new Error("Preview is not running");
            if (capturePending)
              throw new Error("A screenshot is already in progress");
            capturePending = true;
            try {
              // This instance outlives the QA/preview panels. Switching tabs must
              // not reset the native rate-limit window as local button state does.
              const remaining = 1000 - (Date.now() - lastCaptureAt);
              if (remaining > 0)
                await new Promise((resolve) => setTimeout(resolve, remaining));
              let previous = "",
                stable = 0;
              const deadline = Date.now() + 1500;
              while (stable < 2) {
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => resolve()),
                );
                if (disposed || !connected)
                  throw new Error("Preview is not running");
                const current = bounds();
                const key = JSON.stringify(current);
                stable = current.visible && key === previous ? stable + 1 : 0;
                previous = key;
                if (Date.now() > deadline)
                  throw new Error(
                    "Preview is moving or hidden; wait until it is visible and retry the screenshot.",
                  );
              }
              await transport.update({ id, ...bounds() });
              lastCaptureAt = Date.now();
              return await transport.capture!({
                id,
                revisionId: config.revisionId,
              });
            } finally {
              capturePending = false;
            }
          },
        }
      : {}),
    ...(desktop && transport?.annotate
      ? {
          annotate: (bounds: ArtifactElementBounds | null) =>
            transport.annotate!({ id, revisionId: config.revisionId, bounds }),
        }
      : {}),
    send: (type, payload) => {
      if (connected) sendEnvelope(envelope(type, payload));
    },
    destroy,
    update,
  };
}
