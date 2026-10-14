// Session-local LRU cache. Pending reads are shared, but each caller can cancel
// independently without aborting another attachment's download.
export class MediaCache<T> {
  private values = new Map<string, { value: T; size: number }>();
  private pending = new Map<string, Promise<T>>();
  private bytes = 0;

  constructor(private limit: number, private sizeOf: (value: T) => number) {}

  set(key: string, value: T) {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.limit) return;
    this.values.set(key, { value, size });
    this.bytes += size;
    while (this.bytes > this.limit || this.values.size > 256) {
      this.delete(this.values.keys().next().value!);
    }
  }

  delete(key: string) {
    const entry = this.values.get(key);
    if (entry) this.bytes -= entry.size;
    this.values.delete(key);
    this.pending.delete(key);
  }

  async get(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const cached = this.values.get(key);
    if (cached) {
      this.values.delete(key);
      this.values.set(key, cached);
      return cached.value;
    }
    let request = this.pending.get(key);
    if (!request) {
      request = Promise.resolve().then(load).then((value) => {
        if (this.pending.get(key) === request) this.set(key, value);
        return value;
      }).finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
      this.pending.set(key, request);
    }
    if (!signal) return request;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
