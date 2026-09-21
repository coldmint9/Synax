export interface TerminalOutputWriter {
  (data: string, callback: () => void): void;
}

/**
 * Coalesces bursty PTY frames before handing them to xterm. Only one xterm
 * write is kept in flight so acknowledgements describe output that has
 * actually passed through the parser and renderer.
 */
export class TerminalOutputBuffer {
  private chunks: string[] = [];
  private length = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private disposed = false;

  constructor(
    private readonly write: TerminalOutputWriter,
    private readonly committed: (sequence: number) => void,
    private readonly delay = 4,
    private readonly maxBatchLength = 64 * 1024,
  ) {}

  push(data: string, sequence: number): void {
    if (this.disposed || !data) return;
    this.chunks.push(data);
    this.length += data.length;
    this.sequence = Math.max(this.sequence, sequence);
    this.schedule(this.length >= this.maxBatchLength ? 0 : this.delay);
  }

  private schedule(delay: number): void {
    if (this.writing || this.disposed) return;
    if (this.timer) {
      if (delay !== 0) return;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
  }

  private flush(): void {
    if (this.disposed || this.writing || !this.chunks.length) return;
    const data = this.chunks.join("");
    const sequence = this.sequence;
    this.chunks = [];
    this.length = 0;
    this.sequence = 0;
    this.writing = true;
    this.write(data, () => {
      this.writing = false;
      if (this.disposed) return;
      this.committed(sequence);
      if (this.chunks.length) this.schedule(0);
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chunks = [];
    this.length = 0;
  }
}
