import { ObservationConnection } from "./connection";

interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start(): void;
}
interface Subscription { id: string; path: string; cursor?: string }
interface Client { port: Port; seen: number; subscriptions: Map<string, { path: string; release: () => void }> }
interface TicketRequest { client: Client; resolve: (ticket: string) => void; reject: (error: unknown) => void }

/** Port leases handle tab closure/freeze without relying on unreliable unload events. */
export class SharedObservationHub {
  private readonly clients = new Set<Client>();
  private readonly tickets = new Map<string, TicketRequest>();
  private connection?: ObservationConnection;
  private origin?: string;
  private timer?: ReturnType<typeof setInterval>;
  private nextId = 0;
  constructor(private readonly factory: (origin: string, ticket: () => Promise<string>) => ObservationConnection =
    (origin, ticket) => new ObservationConnection({ socketUrl: `${origin.replace(/^http/, "ws")}/api/realtime/socket`, ticket }),
    private readonly now: () => number = Date.now) {}

  attach(port: Port): void {
    const client: Client = { port, seen: this.now(), subscriptions: new Map() };
    port.onmessage = event => {
      const message = event.data;
      if (message?.type === "disconnect") { this.release(client); return; }
      if (message?.type === "ticket") {
        const request = this.tickets.get(message.id);
        if (!request || request.client !== client) return;
        if (typeof message.ticket === "string") request.resolve(message.ticket);
        else request.reject(Object.assign(new Error("Ticket unavailable."), { status: message.status }));
        return;
      }
      if (message?.type !== "sync" || !Array.isArray(message.subscriptions) || message.subscriptions.length > 128) return;
      try {
        if (typeof message.origin !== "string" || !/^https?:\/\//.test(message.origin) || new URL(message.origin).origin !== message.origin) return;
      } catch { return; }
      if (this.origin && this.origin !== message.origin) { port.postMessage({ type: "unavailable" }); return; }
      if (!this.clients.has(client) && this.clients.size >= 64) { port.postMessage({ type: "unavailable" }); return; }
      const wasExpired = !this.clients.has(client);
      this.clients.add(client); client.seen = this.now();
      this.origin ??= message.origin;
      this.connection ??= this.factory(this.origin!, () => this.ticket());
      this.timer ??= setInterval(() => this.sweep(), 15_000);
      const desired = new Map<string, Subscription>();
      for (const item of message.subscriptions as Subscription[]) {
        if (typeof item.id === "string" && /^[a-zA-Z0-9_:-]{1,100}$/.test(item.id) && typeof item.path === "string") desired.set(item.id, item);
      }
      for (const [id, previous] of client.subscriptions) {
        if (desired.get(id)?.path !== previous.path) { previous.release(); client.subscriptions.delete(id); }
      }
      for (const [id, subscription] of desired) {
        if (client.subscriptions.has(id)) continue;
        // No snapshot cache: a late observer must receive its own current snapshot.
        const key = `shared:${++this.nextId}`;
        const release = this.connection.subscribe(key, subscription.path,
          notice => port.postMessage({ type: "notice", id, notice }), subscription.cursor);
        client.subscriptions.set(id, { path: subscription.path, release });
      }
      if (message.wake === true || wasExpired) this.connection.wake();
    };
    port.start();
    port.postMessage({ type: "attached" });
  }
  private release(client: Client): void {
    for (const subscription of client.subscriptions.values()) subscription.release();
    client.subscriptions.clear(); this.clients.delete(client);
    for (const request of this.tickets.values()) if (request.client === client) request.reject(new Error("Ticket provider left."));
    if (!this.clients.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  sweep(): void {
    for (const client of this.clients) {
      if (this.now() - client.seen > 75_000) { this.release(client); client.port.postMessage({ type: "expired" }); }
      else client.port.postMessage({ type: "ping" });
    }
  }
  private async ticket(): Promise<string> {
    const candidates = [...this.clients].sort((a, b) => b.seen - a.seen);
    let failure: unknown = new Error("No active realtime ticket provider.");
    for (const client of candidates) {
      if (!this.clients.has(client)) continue;
      const id = `ticket:${++this.nextId}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<string>((resolve, reject) => {
          this.tickets.set(id, { client, resolve, reject });
          timer = setTimeout(() => reject(new Error("Ticket provider did not respond.")), 2000);
          client.port.postMessage({ type: "ticket-request", id });
        });
      } catch (error) { failure = error; }
      finally { clearTimeout(timer); this.tickets.delete(id); }
    }
    throw failure;
  }
  dispose(): void {
    for (const client of [...this.clients]) this.release(client);
    this.connection?.dispose(); this.connection = undefined;
    clearInterval(this.timer); this.timer = undefined;
  }
}
