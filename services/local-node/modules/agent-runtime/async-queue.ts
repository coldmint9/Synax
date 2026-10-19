// ---------------------------------------------------------------------------
// AsyncQueue<T>
//
// Bridges push-based producers (e.g. event callbacks, stdio notifications)
// to pull-based consumers via AsyncGenerator / `for await`.
// ---------------------------------------------------------------------------

export class AsyncQueue<T> {
  private _queue: T[] = []
  private _waiters: Array<() => void> = []
  private _done = false

  /** Enqueue an item; wakes any waiting iterator. */
  push(item: T): void {
    this._queue.push(item)
    if (this._waiters.length > 0) this._waiters.shift()!()
  }

  /** Signal that no more items will arrive; waiters drain then exit. */
  close(): void {
    this._done = true
    while (this._waiters.length > 0) this._waiters.shift()!()
  }

  /** True once `close()` has been called. */
  get isClosed(): boolean {
    return this._done
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this._queue.length > 0) {
        yield this._queue.shift()!
      } else if (this._done) {
        return
      } else {
        await new Promise<void>((r) => this._waiters.push(r))
      }
    }
  }
}
