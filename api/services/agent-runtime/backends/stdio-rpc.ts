import { createInterface } from 'node:readline';
import { spawnManagedProcess, type ManagedProcess } from '../managed-process.js';

export interface RpcNotification { method: string; params?: unknown }
export class StdioRpc {
  readonly process: ManagedProcess;
  readonly closed: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(event: RpcNotification) => void>();
  private handler?: (method: string, params: unknown) => Promise<unknown>;
  private stderr = '';
  private ended = false;
  failure: Error | undefined;
  constructor(command: string, args: string[], cwd: string) {
    this.process = spawnManagedProcess(command, args, { cwd });
    this.closed = this.process.closed;
    this.process.child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-16_384); });
    const lines = createInterface({ input: this.process.child.stdout });
    lines.on('line', line => {
      if (line.length > 8 * 1024 * 1024) { this.fail(new Error('CLI protocol frame exceeds the size limit.')); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; } // Non-protocol stdout is not an agent message.
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      try { this.receive(message); } catch (error) { this.fail(error instanceof Error ? error : new Error('CLI event handling failed.')); }
    });
    void this.closed.then(() => {
      this.ended = true; lines.close();
      const message = this.stderr.includes('ENOENT') ? 'The configured CLI executable was not found.' : 'The CLI protocol connection closed.';
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure ?? new Error(message)); }
      this.pending.clear();
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); }
    this.pending.clear();
    void this.stop().catch(() => {});
  }
  onNotification(listener: (event: RpcNotification) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void { this.handler = handler; }
  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (this.ended || this.failure) return Promise.reject(this.failure ?? new Error('CLI connection is closed.'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CLI request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private send(message: unknown): void {
    if (this.ended || !this.process.child.stdin.writable) throw new Error('CLI connection is closed.');
    this.process.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error && !this.ended) void this.stop().catch(() => {});
    });
  }
  private receive(message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } }): void {
    if (message.method) {
      if (message.id !== undefined) {
        const answer = Promise.resolve().then(() => {
          if (!this.handler) throw new Error(`Unsupported CLI request: ${message.method}`);
          return this.handler(message.method!, message.params);
        });
        void answer.then(result => { if (!this.ended) this.send({ id: message.id, result }); }, error => {
          if (!this.ended) this.send({ id: message.id, error: { code: -32601, message: error instanceof Error ? error.message : 'Unsupported request.' } });
        }).catch(() => {});
      } else for (const listener of this.listeners) listener({ method: message.method, params: message.params });
      return;
    }
    if (typeof message.id !== 'number') return;
    const request = this.pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? `CLI protocol error ${message.error.code}`));
    else request.resolve(message.result);
  }
  async stop(): Promise<void> { await this.process.stop(); }
}
