export interface ObservationEvent {
  event: string;
  data: string;
  id?: string;
}

interface PendingEvent { value: ObservationEvent; bytes: number; sequence?: number }

/** Auxiliary streams can be repaired from snapshots. A slow observer must not
 * keep an unbounded list of write promises or delay domain mutations. */
export class BoundedEventWriter {
  // Insertion-ordered Map gives O(1) replace/remove/dequeue; no repeated array
  // shift/splice when an observer falls behind a burst of task updates.
  private readonly queue = new Map<string | number, PendingEvent>();
  private nextId = 0;
  private bytes = 0;
  private writing = false;
  private closed = false;
  constructor(
    private readonly write: (event: ObservationEvent) => Promise<unknown>,
    private readonly failed: () => void,
    private readonly maxBytes = 1024 * 1024,
    private readonly maxEvents = 128,
  ) {}

  push(value: ObservationEvent, key?: string, sequence?: number): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(value.data) + Buffer.byteLength(value.event) + (value.id?.length ?? 0);
    if (key) {
      const previous = this.queue.get(key);
      if (previous?.sequence !== undefined && sequence !== undefined && previous.sequence >= sequence) return;
      if (previous) this.bytes -= previous.bytes;
      this.queue.delete(key);
    }
    if (this.bytes + bytes > this.maxBytes || this.queue.size >= this.maxEvents) {
      this.fail();
      return;
    }
    this.queue.set(key ?? ++this.nextId, { value, bytes, sequence });
    this.bytes += bytes;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing || this.closed) return;
    this.writing = true;
    try {
      while (!this.closed && this.queue.size) {
        const key = this.queue.keys().next().value!;
        const item = this.queue.get(key)!;
        this.queue.delete(key);
        // Include the in-flight payload in the byte budget until it is released.
        await this.write(item.value);
        if (this.closed) return;
        this.bytes -= item.bytes;
      }
    } catch { this.fail(); }
    finally { this.writing = false; }
  }

  private fail(): void {
    if (this.closed) return;
    this.dispose();
    this.failed();
  }

  dispose(): void {
    this.closed = true;
    this.queue.clear();
    this.bytes = 0;
  }
}
