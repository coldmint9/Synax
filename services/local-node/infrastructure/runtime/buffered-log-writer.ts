import { appendFile } from 'node:fs/promises';

type Batch = { chunks: Buffer[]; bytes: number };
type Append = (file: string, data: Buffer) => Promise<void>;

/** Diagnostic logs must neither block request handling nor grow without bound
 * when the disk is slow. Execution/history durability uses its own Rust store. */
export class BufferedLogWriter {
  private readonly pending = new Map<string, Batch>();
  private retainedBytes = 0;
  private dropped = 0;
  private scheduled?: ReturnType<typeof setImmediate>;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly append: Append = (file, data) => appendFile(file, data, { mode: 0o600 }),
    private readonly report: (message: string) => void = message => { process.stderr.write(`${message}\n`); },
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  write(file: string, text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.retainedBytes + bytes > this.maxBytes) {
      this.dropped++;
    } else {
      let batch = this.pending.get(file);
      if (!batch) this.pending.set(file, batch = { chunks: [], bytes: 0 });
      batch.chunks.push(Buffer.from(text));
      batch.bytes += bytes;
      this.retainedBytes += bytes;
    }
    this.scheduled ??= setImmediate(() => { this.scheduled = undefined; void this.flush(); });
  }

  /** Fence only entries already queued; new logging cannot starve a log read
   * or shutdown behind an indefinitely growing producer. */
  flush(): Promise<void> {
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    const batches = [...this.pending];
    this.pending.clear();
    if (!batches.length) {
      if (!this.retainedBytes) this.reportDropped();
      return this.tail;
    }
    this.tail = this.tail.then(async () => {
      for (const [file, batch] of batches) {
        try { await this.append(file, Buffer.concat(batch.chunks, batch.bytes)); }
        catch (error) { this.safeReport(`Unable to persist diagnostic log: ${String(error)}`); }
        finally { batch.chunks = []; this.retainedBytes -= batch.bytes; }
      }
      this.reportDropped();
    });
    return this.tail;
  }

  private safeReport(message: string): void {
    try { this.report(message); } catch { /* stderr may already be closed */ }
  }

  private reportDropped(): void {
    if (!this.dropped) return;
    const dropped = this.dropped;
    this.dropped = 0;
    this.safeReport(`Diagnostic log buffer full: dropped ${dropped} entries.`);
  }
}

export const diagnosticLogWriter = new BufferedLogWriter();
export const flushDiagnosticLogs = (): Promise<void> => diagnosticLogWriter.flush();
