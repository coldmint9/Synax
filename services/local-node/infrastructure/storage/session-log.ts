import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const MAX_BATCH = 2 * 1024 * 1024;
const SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_QUEUE_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export interface LogEvent { type: string; payload: unknown }
export interface LogReceipt { requestId: string; firstSeq: number; lastSeq: number; hash: string }
export interface CommittedEvent extends LogEvent { sequence: number }
interface Envelope {
  format: 1; sessionId: string; requestId: string; digest: string;
  firstSeq: number; previous: string; events: LogEvent[]; hash: string;
}
interface SessionState {
  sequence: number; hash: string; segment: number; bytes: number; directory: string; handle?: fs.FileHandle; handleSegment?: number;
  receipts: Map<string, { digest: string; receipt: LogReceipt }>;
  producers: Map<string, number>;
  firstSegment: number; totalBytes: number; readers: number;
  batches: Array<{ segment: number; offset: number; length: number; first: number; last: number }>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hashEnvelope = ({ hash: _hash, ...rest }: Envelope) => digest(JSON.stringify(rest));
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
function sessionKey(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw error('LOG_SESSION_INVALID', 'Invalid session log identifier.');
}

/** The storage host owns this instance and its files. Never construct competing
 * writers for the same root. Commits within one session are serial; other
 * sessions use independent async write/fsync operations. No SQLite dependency. */
export class SessionLog {
  private closed = false;
  private freeDisk = { checkedAt: 0, bytes: 0 };
  private queues = new Map<string, Promise<unknown>>();
  private queuedBytes = new Map<string, number>();
  private totalBytes = 0;
  private states = new Map<string, SessionState>();
  private loading = new Map<string, Promise<SessionState>>();
  private failures = new Map<string, unknown>();
  constructor(readonly root: string, private readonly options: { replayRetention?: number; compactBytes?: number } = {}) {}

  async append(sessionId: string, requestId: string, events: LogEvent[]): Promise<LogReceipt> {
    sessionKey(sessionId);
    if (this.closed) throw error('LOG_CLOSED', 'Session log is closed.');
    if (!requestId || requestId.length > 200 || !events.length || events.length > 256)
      throw error('LOG_BATCH_INVALID', 'Invalid log batch.');
    // Freeze the admitted input: a producer cannot mutate an in-flight commit.
    const encoded = JSON.stringify(events);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_BATCH) throw error('LOG_BATCH_TOO_LARGE', 'Log batch exceeds its byte budget.');
    if (this.totalBytes + bytes > MAX_QUEUE_BYTES || (this.queuedBytes.get(sessionId) ?? 0) + bytes > MAX_SESSION_QUEUE_BYTES)
      throw error('LOG_BACKPRESSURE', 'Session storage queue is full; wait for outstanding commits.');
    const frozen = JSON.parse(encoded) as LogEvent[];
    if (this.options.replayRetention && frozen.some(event => event.type !== 'runtime.replay'))
      throw error('LOG_REPLAY_ONLY', 'A retained replay log cannot store authoritative session events.');
    this.totalBytes += bytes;
    this.queuedBytes.set(sessionId, (this.queuedBytes.get(sessionId) ?? 0) + bytes);
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      if (this.failures.has(sessionId)) throw error('LOG_RECOVERY_REQUIRED', 'A failed write requires exclusive log recovery before retry.');
      const state = await this.load(sessionId);
      const contentDigest = digest(encoded);
      const existing = state.receipts.get(requestId);
      if (existing) {
        if (existing.digest !== contentDigest) throw error('LOG_REQUEST_CONFLICT', 'Request ID already contains different events.');
        return existing.receipt;
      }
      const producer = this.producer(requestId);
      if (producer && producer.number <= (state.producers.get(producer.id) ?? 0))
        throw error('LOG_REQUEST_RETIRED', 'This replay request was already committed outside the retained replay window.');
      // Bounded idempotency metadata; never silently forget acknowledged IDs.
      if (state.receipts.size >= 65_536) throw error('LOG_REQUEST_BUDGET', 'Session request budget exhausted.');
      const envelope: Envelope = {
        format: 1, sessionId, requestId, digest: contentDigest,
        firstSeq: state.sequence + 1, previous: state.hash, events: frozen, hash: '',
      };
      envelope.hash = hashEnvelope(envelope);
      const line = Buffer.from(JSON.stringify(envelope) + '\n');
      if (Date.now() - this.freeDisk.checkedAt > 1000) {
        const disk = await fs.statfs(this.root);
        this.freeDisk = { checkedAt: Date.now(), bytes: disk.bavail * disk.bsize };
      }
      if (this.freeDisk.bytes < 512 * 1024 * 1024 + this.totalBytes + line.length)
        throw error('LOG_DISK_RESERVE', 'Insufficient free disk space to preserve the recovery reserve.');
      const dir = state.directory;
      const originalSegment = state.segment, originalBytes = state.bytes;
      const segment = state.bytes >= SEGMENT_BYTES ? state.segment + 1 : state.segment;
      const file = this.filename(dir, segment);
      let handle: fs.FileHandle | undefined;
      try {
        if (!state.handle || state.handleSegment !== segment) {
          await state.handle?.close();
          state.handle = undefined;
          handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
          if (!(await handle.stat()).isFile()) { await handle.close(); throw error('LOG_FILE_INVALID', 'Session log is not a regular file.'); }
          state.handle = handle; state.handleSegment = segment;
        } else handle = state.handle;
        let written = 0;
        while (written < line.length) {
          const result = await handle.write(line, written, line.length - written);
          if (!result.bytesWritten) throw error('LOG_SHORT_WRITE', 'Session log made no write progress.');
          written += result.bytesWritten;
        }
        await handle.sync();
        // New entries must be durable before acknowledging the first batch.
        if (!state.bytes || segment !== state.segment) await this.syncDirectory(dir);
      } catch (failure) {
        this.failures.set(sessionId, failure);
        throw failure;
      }
      this.freeDisk.bytes -= line.length;
      const receipt = { requestId, firstSeq: envelope.firstSeq, lastSeq: envelope.firstSeq + frozen.length - 1, hash: envelope.hash };
      state.batches.push({ segment, offset: segment === originalSegment ? originalBytes : 0, length: line.length, first: receipt.firstSeq, last: receipt.lastSeq });
      state.segment = segment;
      // The previous segment length must not count against the newly opened one.
      state.bytes = segment === originalSegment ? originalBytes + line.length : line.length;
      state.sequence = receipt.lastSeq;
      state.hash = receipt.hash;
      this.remember(state, requestId, contentDigest, receipt);
      state.totalBytes += line.length;
      // Replay is a bounded diagnostic window; authoritative session events
      // use the default non-compacting protocol. Compaction never runs with an
      // active reader and publishes a durable manifest before deleting files.
      if (this.options.replayRetention && !state.readers && state.totalBytes > (this.options.compactBytes ?? 32 * 1024 * 1024)) {
        try { await this.compactReplay(sessionId, state); }
        catch (failure) { console.warn('Session replay compaction deferred:', (failure as Error).message); }
      }
      return receipt;
    });
    this.queues.set(sessionId, pending);
    try { return await pending; } finally {
      this.totalBytes -= bytes;
      const remaining = (this.queuedBytes.get(sessionId) ?? bytes) - bytes;
      if (remaining) this.queuedBytes.set(sessionId, remaining); else this.queuedBytes.delete(sessionId);
      if (this.queues.get(sessionId) === pending) this.queues.delete(sessionId);
    }
  }

  async cursor(sessionId: string): Promise<number> {
    sessionKey(sessionId);
    await this.queues.get(sessionId);
    return (await this.load(sessionId)).sequence;
  }
  async status(sessionId: string, requestId: string): Promise<LogReceipt | undefined> {
    sessionKey(sessionId);
    await this.queues.get(sessionId);
    return (await this.load(sessionId)).receipts.get(requestId)?.receipt;
  }
  async read(sessionId: string, after = 0, limit = 256): Promise<CommittedEvent[]> {
    sessionKey(sessionId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw error('LOG_CURSOR_INVALID', 'Invalid session log cursor.');
    await this.queues.get(sessionId);
    const state = await this.load(sessionId);
    const dir = state.directory;
    state.readers++;
    try {
    const frontier = state.sequence;
    const result: CommittedEvent[] = [];
    let responseBytes = 0;
    // Binary search the sparse batch index: reconnect cost is independent of
    // the entire transcript size, and no read races with an uncommitted tail.
    let low = 0, high = state.batches.length;
    while (low < high) { const mid = (low + high) >>> 1; if (state.batches[mid].last <= after) low = mid + 1; else high = mid; }
    const batches = state.batches.slice(low);
    for (const batch of batches) {
      const handle = await fs.open(this.filename(dir, batch.segment), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const bytes = Buffer.alloc(batch.length);
      try {
        let n = 0;
        while (n < bytes.length) {
          const read = await handle.read(bytes, n, bytes.length - n, batch.offset + n);
          if (!read.bytesRead) throw error('LOG_CORRUPT', 'Committed session log bytes are missing.');
          n += read.bytesRead;
        }
      } finally { await handle.close(); }
      const record = this.decode(bytes.subarray(0, bytes.length - 1));
      for (let i = 0; i < record.events.length; i++) {
        const sequence = record.firstSeq + i;
        if (sequence <= after || sequence > frontier) continue;
        const event = { ...record.events[i], sequence };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (result.length && responseBytes + size > MAX_BATCH) return result;
        result.push(event); responseBytes += size;
        if (result.length === limit) return result;
      }
    }
    return result;
    } finally { state.readers--; }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.all([...this.states.values()].map(async state => { await state.handle?.close(); state.handle = undefined; }));
  }

  private async load(sessionId: string): Promise<SessionState> {
    const cached = this.states.get(sessionId);
    if (cached) return cached;
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = this.recover(sessionId);
      this.loading.set(sessionId, pending);
      void pending.finally(() => this.loading.delete(sessionId)).catch(() => {});
    }
    return pending;
  }
  private async recover(sessionId: string): Promise<SessionState> {
    const cached = this.states.get(sessionId);
    if (cached) return cached;
    const dir = await this.directory(sessionId);
    const state: SessionState = { sequence: 0, hash: '0'.repeat(64), segment: 1, bytes: 0, directory: dir, receipts: new Map(), batches: [], producers: new Map(), firstSegment: 1, totalBytes: 0, readers: 0 };
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(dir, 'replay-manifest.json'), 'utf8')) as { data: string; hash: string };
      if (digest(envelope.data) !== envelope.hash) throw error('LOG_CORRUPT', 'Replay manifest checksum mismatch.');
      if (!this.options.replayRetention) throw error('LOG_MODE_MISMATCH', 'Replay retention metadata requires replay mode.');
      const manifest = JSON.parse(envelope.data) as { format: number; firstSegment: number; sequence: number; hash: string; producers: [string, number][]; receipts: [string, { digest: string; receipt: LogReceipt }][] };
      if (manifest.format !== 1 || !Number.isSafeInteger(manifest.firstSegment) || manifest.firstSegment < 1 || !HASH.test(manifest.hash)) throw error('LOG_CORRUPT', 'Invalid replay manifest.');
      state.sequence = manifest.sequence; state.hash = manifest.hash; state.firstSegment = manifest.firstSegment;
      state.segment = manifest.firstSegment; state.producers = new Map(manifest.producers); state.receipts = new Map(manifest.receipts);
      const published = this.filename(dir, state.firstSegment);
      try { await fs.access(published); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
        await fs.rename(published + '.compact', published);
        await this.syncDirectory(dir);
      }
    } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    const segments = (await fs.readdir(dir)).filter(name => /^events-\d{8}\.jsonl$/.test(name) && Number(name.slice(7, 15)) >= state.firstSegment).sort();
    if (state.firstSegment > 1 && !segments.length) throw error('LOG_CORRUPT', 'Compacted replay segment is missing.');
    for (let index = 0; index < segments.length; index++) {
      if (segments[index] !== path.basename(this.filename(dir, state.firstSegment + index))) throw error('LOG_CORRUPT', 'Session log segment is missing.');
      const file = path.join(dir, segments[index]);
      let validBytes = 0;
      for await (const record of this.records(file, index === segments.length - 1)) {
        if (record.sessionId !== sessionId || record.previous !== state.hash || record.firstSeq !== state.sequence + 1 ||
          state.receipts.has(record.requestId)) throw error('LOG_CORRUPT', 'Session log chain is invalid.');
        const receipt = { requestId: record.requestId, firstSeq: record.firstSeq, lastSeq: record.firstSeq + record.events.length - 1, hash: record.hash };
        state.sequence = receipt.lastSeq; state.hash = receipt.hash;
        this.remember(state, record.requestId, record.digest, receipt);
        const length = Buffer.byteLength(JSON.stringify(record) + '\n');
        state.batches.push({ segment: state.firstSegment + index, offset: validBytes, length, first: receipt.firstSeq, last: receipt.lastSeq });
        validBytes += length;
      }
      if (index === segments.length - 1) {
        const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
          if ((await handle.stat()).size !== validBytes) await handle.truncate(validBytes);
          // Surviving unacknowledged batches become durable during recovery.
          await handle.sync();
        } finally { await handle.close(); }
      }
      state.segment = state.firstSegment + index; state.bytes = validBytes; state.totalBytes += validBytes;
    }
    if (this.states.size >= 128) {
      for (const [id, other] of this.states) {
        if (!this.queues.has(id)) { await other.handle?.close(); this.states.delete(id); break; }
      }
      if (this.states.size >= 128) throw error('LOG_ACTIVE_SESSION_BUDGET', 'Too many simultaneously active log sessions.');
    }
    this.states.set(sessionId, state);
    return state;
  }
  private async *records(file: string, allowPartialTail = false): AsyncGenerator<Envelope> {
    let handle: fs.FileHandle;
    try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return; throw failure; }
    try {
      if (!(await handle.stat()).isFile()) throw error('LOG_FILE_INVALID', 'Session log is not a regular file.');
      let pending = Buffer.alloc(0);
      const chunk = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          yield this.decode(line);
        }
        if (pending.length > MAX_BATCH + 64 * 1024) throw error('LOG_CORRUPT', 'Session log line exceeds its byte budget.');
      }
      if (pending.length && !allowPartialTail) throw error('LOG_CORRUPT', 'Incomplete sealed session log.');
    } finally { await handle.close(); }
  }
  private producer(requestId: string): { id: string; number: number } | undefined {
    if (!this.options.replayRetention) return;
    const match = /^replay:([a-f0-9-]{36}):(\d+)$/.exec(requestId);
    if (!match) return;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1) throw error('LOG_REQUEST_INVALID', 'Invalid replay producer sequence.');
    return { id: match[1], number };
  }
  private remember(state: SessionState, requestId: string, requestDigest: string, receipt: LogReceipt): void {
    const producer = this.producer(requestId);
    if (producer) state.producers.set(producer.id, Math.max(producer.number, state.producers.get(producer.id) ?? 0));
    state.receipts.set(requestId, { digest: requestDigest, receipt });
    if (this.options.replayRetention && state.receipts.size > 2048) {
      for (const [id, value] of state.receipts) {
        if (this.producer(id) && value.receipt.lastSeq < state.sequence - 1024) state.receipts.delete(id);
        if (state.receipts.size <= 1024) break;
      }
    }
  }
  private async compactReplay(sessionId: string, state: SessionState): Promise<void> {
    const cutoff = Math.max(0, state.sequence - this.options.replayRetention!);
    const start = state.batches.findIndex(batch => batch.last > cutoff);
    if (start <= 0) return;
    const batches = state.batches.slice(start);
    const segment = state.segment + 1;
    const output = this.filename(state.directory, segment);
    const temporary = output + '.tmp';
    // Failed previous compactions may have left unpublished staging bytes.
    const target = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    let bytes = 0;
    let firstRecord: Envelope | undefined;
    const relocated: SessionState['batches'] = [];
    try {
      for (const batch of batches) {
        const source = await fs.open(this.filename(state.directory, batch.segment), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const line = Buffer.alloc(batch.length);
        try {
          let read = 0;
          while (read < line.length) { const result = await source.read(line, read, line.length - read, batch.offset + read); if (!result.bytesRead) throw error('LOG_CORRUPT', 'Missing replay bytes during compaction.'); read += result.bytesRead; }
        } finally { await source.close(); }
        const record = this.decode(line.subarray(0, line.length - 1));
        firstRecord ??= record;
        let written = 0;
        while (written < line.length) { const result = await target.write(line, written, line.length - written); if (!result.bytesWritten) throw error('LOG_SHORT_WRITE', 'Replay compaction made no progress.'); written += result.bytesWritten; }
        relocated.push({ ...batch, segment, offset: bytes }); bytes += line.length;
      }
      await target.sync();
    } finally { await target.close(); }
    await fs.rename(temporary, output + '.compact');
    await this.syncDirectory(state.directory);
    const data = JSON.stringify({ format: 1, firstSegment: segment, sequence: firstRecord!.firstSeq - 1, hash: firstRecord!.previous,
      producers: [...state.producers], receipts: [...state.receipts].filter(([id, value]) => !this.producer(id) && value.receipt.lastSeq < firstRecord!.firstSeq) });
    const manifest = path.join(state.directory, 'replay-manifest.json');
    const manifestHandle = await fs.open(manifest + '.tmp', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await manifestHandle.writeFile(JSON.stringify({ data, hash: digest(data) })); await manifestHandle.sync(); }
    finally { await manifestHandle.close(); }
    const first = state.firstSegment, last = state.segment;
    try {
      await fs.rename(manifest + '.tmp', manifest);
      await this.syncDirectory(state.directory);
      await fs.rename(output + '.compact', output);
      await this.syncDirectory(state.directory);
      await state.handle?.close(); state.handle = undefined;
      state.segment = segment; state.firstSegment = segment; state.bytes = bytes; state.totalBytes = bytes; state.batches = relocated;
    } catch (failure) {
      // The manifest publication may already be durable. Never append to the old
      // generation after an ambiguous cutover; exclusive recovery resolves it.
      this.failures.set(sessionId, failure);
      throw failure;
    }
    for (let n = first; n <= last; n++) await fs.unlink(this.filename(state.directory, n));
    await this.syncDirectory(state.directory);
  }
  private decode(line: Buffer): Envelope {
    let record: Envelope;
    try { record = JSON.parse(line.toString('utf8')); } catch { throw error('LOG_CORRUPT', 'Invalid session log JSON.'); }
    if (!record || typeof record !== 'object' || record.format !== 1 || !Array.isArray(record.events) || !record.events.length || record.events.length > 256 ||
      !Number.isSafeInteger(record.firstSeq) || !HASH.test(record.hash) || hashEnvelope(record) !== record.hash ||
      digest(JSON.stringify(record.events)) !== record.digest || !line.equals(Buffer.from(JSON.stringify(record))))
      throw error('LOG_CORRUPT', 'Invalid session log checksum or encoding.');
    return record;
  }
  private filename(dir: string, segment: number): string { return path.join(dir, `events-${String(segment).padStart(8, '0')}.jsonl`); }
  private async directory(id: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.root)).isDirectory()) throw error('LOG_DIRECTORY_INVALID', 'Invalid log root.');
    const dir = path.join(this.root, id);
    let created = false;
    try { await fs.mkdir(dir, { mode: 0o700 }); created = true; }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
    if (!(await fs.lstat(dir)).isDirectory()) throw error('LOG_DIRECTORY_INVALID', 'Invalid session directory.');
    if (created) await this.syncDirectory(this.root);
    return dir;
  }
  private async syncDirectory(dir: string): Promise<void> {
    if (process.platform === 'win32') return; // Windows directory handles require a native flush adapter.
    const handle = await fs.open(dir, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
