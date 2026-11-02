import net from "node:net";
import os from "node:os";
import { logger } from "../../../infrastructure/runtime/logger.js";

/** A probe answers one question: can this host reach the model endpoint now? */
export type ConnectivityProbe = () => Promise<boolean>;

const DEFAULT_ONLINE_INTERVAL_MS = 45_000;
const DEFAULT_OFFLINE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_500;
/** A failure report must not launch one probe per failed session. */
const FAILURE_PROBE_THROTTLE_MS = 3_000;

function hasNetworkInterface(): boolean {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family === "IPv4" && address.address.startsWith("169.254."))
        continue;
      if (address.family === "IPv4" || address.family === "IPv6") return true;
    }
  }
  return false;
}

function connectProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (online: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Resolve the endpoint worth probing from the configured provider.
 *
 * A provider that lives on this machine says nothing about internet access, so
 * it is skipped: the interface check already answers that case.
 */
async function resolveTarget(): Promise<{ host: string; port: number } | null> {
  try {
    const { getGlobalConfigForRuntime } = await import(
      "../../../infrastructure/runtime/config/config-store.js"
    );
    const config = getGlobalConfigForRuntime();
    const connection =
      config.providerConnections?.[config.defaultApiProviderId] ??
      Object.values(config.providerConnections ?? {})[0];
    const baseUrl = connection?.baseUrl?.trim();
    if (!baseUrl) return null;
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
    const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
    return Number.isFinite(port) && port > 0 ? { host, port } : null;
  } catch (error) {
    logger.warn({ error }, "[auto-resume] connectivity target could not be resolved");
    return null;
  }
}

export interface ConnectivityMonitorOptions {
  probe?: ConnectivityProbe;
  onlineIntervalMs?: number;
  offlineIntervalMs?: number;
  onChange?: (online: boolean) => void;
}

/**
 * Local view of whether the model endpoint is reachable.
 *
 * Two signals are combined: a missing interface is decisive and free, while a
 * TCP connect to the configured provider catches "connected to Wi-Fi, no route".
 * Probes poll slowly while online and quickly while offline, so a restored
 * network is noticed within seconds without a timer storm.
 */
export class ConnectivityMonitor {
  private online = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probing: Promise<boolean> | undefined;
  private stopped = true;
  private lastFailureProbeAt = 0;
  private readonly listeners = new Set<(online: boolean) => void>();
  private readonly probe: ConnectivityProbe;
  private readonly onlineIntervalMs: number;
  private readonly offlineIntervalMs: number;

  constructor(options: ConnectivityMonitorOptions = {}) {
    this.probe = options.probe ?? defaultProbe;
    this.onlineIntervalMs = options.onlineIntervalMs ?? DEFAULT_ONLINE_INTERVAL_MS;
    this.offlineIntervalMs = options.offlineIntervalMs ?? DEFAULT_OFFLINE_INTERVAL_MS;
    if (options.onChange) this.listeners.add(options.onChange);
  }

  get isOnline(): boolean {
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.probeNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * A run just failed with a transport error: verify reachability instead of
   * trusting the last poll. Throttled because a whole wave of sessions fails
   * at once.
   */
  noteNetworkFailure(): void {
    const now = Date.now();
    if (now - this.lastFailureProbeAt < FAILURE_PROBE_THROTTLE_MS) return;
    this.lastFailureProbeAt = now;
    void this.probeNow();
  }

  probeNow(): Promise<boolean> {
    this.probing ??= this.runProbe().finally(() => {
      this.probing = undefined;
      this.schedule();
    });
    return this.probing;
  }

  private async runProbe(): Promise<boolean> {
    let online: boolean;
    try {
      online = hasNetworkInterface() && (await this.probe());
    } catch {
      online = false;
    }
    this.setOnline(online);
    return online;
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    logger.info({ online }, "[auto-resume] connectivity changed");
    for (const listener of this.listeners) {
      try {
        listener(online);
      } catch (error) {
        logger.warn({ error }, "[auto-resume] connectivity listener failed");
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.probeNow();
    }, this.online ? this.onlineIntervalMs : this.offlineIntervalMs);
    this.timer.unref?.();
  }
}

async function defaultProbe(): Promise<boolean> {
  const target = await resolveTarget();
  // Without a configured endpoint there is nothing meaningful to probe; the
  // interface check already ran, so treat the host as reachable.
  if (!target) return true;
  return connectProbe(target.host, target.port);
}
