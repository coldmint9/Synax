import { useApiConnectivityStore } from "../../apiConnectivity";
import { apiFetch } from "../origin";
import { getApiOrigin } from "../originConfig";
import { ObservationConnection, type ObservationHandler } from "./connection";

interface Binding { path: string; cursor?: string; notify: ObservationHandler; release?: () => void }
let bridge: ObservationBridge | undefined;
let nextId = 0;

async function ticket(): Promise<string> {
  const response = await apiFetch("/api/realtime/connection", { method: "POST" });
  if (!response.ok) throw Object.assign(new Error("Realtime authentication failed."), { status: response.status });
  const body = await response.json() as { ticket: string };
  if (typeof body.ticket !== "string") throw new Error("Invalid realtime grant.");
  return body.ticket;
}

class ObservationBridge {
  private readonly bindings = new Map<string, Binding>();
  private worker?: SharedWorker;
  private direct?: ObservationConnection;
  private suspended = false;
  private readonly lifecycle = new AbortController();
  private startup?: ReturnType<typeof setTimeout>;
  private stopRecovery: () => void = () => {};
  constructor(readonly origin: string) {
    try {
      if (typeof SharedWorker === "undefined") throw new Error("SharedWorker unavailable.");
      this.worker = new SharedWorker(new URL("./shared-worker.ts", import.meta.url), { type: "module", name: `synax-observation-v1:${origin}` });
      this.worker.port.onmessage = event => {
        const message = event.data;
        if (message?.type === "attached") clearTimeout(this.startup);
        if (message?.type === "ticket-request") {
          const port = this.worker?.port;
          void ticket().then(value => port?.postMessage({ type: "ticket", id: message.id, ticket: value }),
            error => port?.postMessage({ type: "ticket", id: message.id, status: error?.status }));
        }
        if (message?.type === "ping" || message?.type === "expired") {
          if (!this.suspended) this.sync();
        }
        if (message?.type === "unavailable") this.fallback();
        if (message?.type === "notice") {
          const binding = this.bindings.get(message.id);
          if (binding) {
            if (message.notice?.type === "event" && typeof message.notice.lastEventId === "string") binding.cursor = message.notice.lastEventId;
            binding.notify(message.notice);
          }
        }
      };
      this.worker.onerror = () => this.fallback();
      this.worker.port.start();
      this.startup = setTimeout(() => this.fallback(), 5000);
    } catch { this.fallback(); }
    const listenerOptions = { signal: this.lifecycle.signal };
    window.addEventListener("pagehide", () => {
      this.suspended = true;
      this.worker?.port.postMessage({ type: "disconnect" });
      this.direct?.dispose(); this.direct = undefined;
    }, listenerOptions);
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      this.suspended = false;
      if (this.worker) this.sync(true);
      else { this.fallback(); this.direct?.wake(); }
    };
    window.addEventListener("pageshow", wake, listenerOptions);
    window.addEventListener("online", wake, listenerOptions);
    window.addEventListener("focus", wake, listenerOptions);
    document.addEventListener("visibilitychange", wake, listenerOptions);
    this.stopRecovery = useApiConnectivityStore.subscribe((state, previous) => {
      if (state.apiReachable === "reachable" && state.recoveryVersion !== previous.recoveryVersion) wake();
    });
  }
  dispose(): void {
    clearTimeout(this.startup);
    this.lifecycle.abort(); this.stopRecovery();
    this.worker?.port.postMessage({ type: "disconnect" });
    this.worker?.port.close(); this.worker = undefined;
    this.direct?.dispose(); this.direct = undefined; this.bindings.clear();
  }
  private fallback(): void {
    clearTimeout(this.startup);
    if (this.worker) {
      this.worker.port.postMessage({ type: "disconnect" });
      this.worker.port.close(); this.worker = undefined;
    }
    if (this.direct || this.suspended) return;
    // Still one WS per page: lack of SharedWorker must never restore four HTTP SSEs.
    this.direct = new ObservationConnection({ socketUrl: `${this.origin.replace(/^http/, "ws")}/api/realtime/socket`, ticket });
    for (const [id, binding] of this.bindings) this.bindDirect(id, binding);
  }
  private bindDirect(id: string, binding: Binding): void {
    binding.release = this.direct!.subscribe(id, binding.path, notice => {
      if (notice.type === "event") binding.cursor = notice.lastEventId;
      binding.notify(notice);
    }, binding.cursor);
  }
  private sync(wake = false): void {
    if (this.suspended) return;
    this.worker?.port.postMessage({ type: "sync", origin: this.origin, wake,
      subscriptions: [...this.bindings].map(([id, b]) => ({ id, path: b.path, cursor: b.cursor })) });
  }
  subscribe(path: string, notify: ObservationHandler): () => void {
    const id = `observation:${++nextId}`;
    const binding: Binding = { path, notify };
    this.bindings.set(id, binding);
    if (this.direct) this.bindDirect(id, binding);
    else this.sync();
    return () => { binding.release?.(); this.bindings.delete(id); this.sync(); };
  }
}

export function subscribeObservation(path: string, notify: ObservationHandler): () => void {
  const origin = getApiOrigin() || window.location.origin;
  // Desktop sidecar port can change after a failed/retried startup.
  if (!bridge || bridge.origin !== origin) { bridge?.dispose(); bridge = new ObservationBridge(origin); }
  return bridge.subscribe(path, notify);
}

if (import.meta.hot) import.meta.hot.dispose(() => { bridge?.dispose(); bridge = undefined; });
