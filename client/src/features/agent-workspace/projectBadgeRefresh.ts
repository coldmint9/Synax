/** One owner for badge refreshes in a mounted workspace scope. Events arriving
 * during a request retain one trailing refresh; sustained activity cannot starve
 * it or create concurrent requests. Disposal fences late responses. */
export class ProjectBadgeRefresh<T> {
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private stopped = false;
  private lastStarted = -Infinity;

  constructor(private readonly read: () => Promise<T>, private readonly accept: (value: T) => void) {}

  invalidate(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.pending || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, Math.max(300, 1_000 - (Date.now() - this.lastStarted)));
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.lastStarted = Date.now();
    this.pending = Promise.resolve().then(this.read).then(value => {
      if (!this.stopped) this.accept(value);
    }).catch(() => {
      // Best effort: retain the last snapshot and recover on the next event.
    }).finally(() => {
      this.pending = null;
      if (this.dirty) this.invalidate();
    });
    return this.pending;
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }
}
