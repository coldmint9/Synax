import fs from "node:fs/promises";
import { constants, watch } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import { GitMrStore } from "./store.js";
import { hostPath, repoPath } from './repository.js';
import { git, safeWorktreeFile, MAX_FILE_BYTES, MAX_VIEW_FILE_BYTES, MAX_FILE_PREVIEW_BYTES, MAX_FILE_SLICE_BYTES, MAX_BLOB_BYTES, spoolGitBlob } from "./repository.js";
import { GitMrError } from "./errors.js";
import type {
  MergeFile,
  MergeFileSummary,
  MergeFileSave,
  MergeRequest, MergeFileSide, MergeFileSlice, MergeFileSliceInput,
} from "./contracts.js";
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
// Avoid retaining a large Git stdout backing string through small substring views.
const ownString = (text: string) => Buffer.from(text, 'utf8').toString('utf8');
export const fileId = (file: string) => digest(file);
interface Entry {
  stage: number;
  oid: string;
  mode: string;
  path: string;
}
type FileIndex = { expiresAt: number; accessedAt: number; bytes: number; signature: string; files: MergeFileSummary[]; byId: Map<string, MergeFileSummary>; positions: Map<string, number>; entries: Map<string, Entry[]> };
const fileIndexes = new Map<string, FileIndex>();
const MAX_INDEX_FILES = 100_000;
const MAX_INDEXES = 8;
export const MAX_FILE_INDEX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
let indexCacheBytes = 0;
let activeContentRead = false;
const contentWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort: () => void }> = [];
async function withContentReadBudget<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (activeContentRead) {
    if (contentWaiters.length >= 8) throw new GitMrError('Too many content reads are waiting.', 'CONTENT_READER_BUSY', 429);
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: () => {} };
      entry.onAbort = () => { const index = contentWaiters.indexOf(entry); if (index >= 0) contentWaiters.splice(index, 1); reject(signal?.reason ?? new DOMException('Read cancelled.', 'AbortError')); };
      contentWaiters.push(entry); signal?.addEventListener('abort', entry.onAbort, { once: true });
      if (signal?.aborted) entry.onAbort();
    });
  } else activeContentRead = true;
  try { signal?.throwIfAborted(); return await work(); }
  finally { const next = contentWaiters.shift(); if (next) { next.signal?.removeEventListener('abort', next.onAbort); next.resolve(); } else activeContentRead = false; }
}
function forgetIndex(id: string) {
  const old = fileIndexes.get(id);
  if (old) indexCacheBytes -= old.bytes;
  fileIndexes.delete(id);
}
function pruneIndexes(now = Date.now()) {
  for (const [id, entry] of fileIndexes) if (now - entry.accessedAt >= CACHE_TTL_MS) forgetIndex(id);
}
async function indexSignature(mr: MergeRequest, signal?: AbortSignal): Promise<string> {
  const indexPath = (await git(mr, ['rev-parse', '--git-path', 'index'], { cwd: mr.worktree, signal })).stdout.trim();
  const paths = repoPath(mr);
  const index = await fs.stat(hostPath(mr, paths.isAbsolute(indexPath) ? indexPath : paths.resolve(mr.worktree!, indexPath))).catch(() => null);
  return `${index?.ino ?? 0}:${index?.mtimeMs ?? 0}:${index?.ctimeMs ?? 0}:${index?.size ?? 0}:${mr.targetOid}:${mr.currentStep}`;
}
function boundedIndex(mr: MergeRequest, index: FileIndex) {
  pruneIndexes(); forgetIndex(mr.id);
  if (index.bytes > MAX_FILE_INDEX_CACHE_BYTES) throw new GitMrError('Merge file manifest exceeds the bounded index budget.', 'FILE_INDEX_LIMIT');
  while (fileIndexes.size >= MAX_INDEXES || indexCacheBytes + index.bytes > MAX_FILE_INDEX_CACHE_BYTES) forgetIndex(fileIndexes.keys().next().value!);
  fileIndexes.set(mr.id, index); indexCacheBytes += index.bytes;
}
export function invalidateMergeFileIndex(mrId: string): void { forgetIndex(mrId); }
export async function updateResolvedFileIndex(mr: MergeRequest, id: string): Promise<void> {
  const index = fileIndexes.get(mr.id), old = index?.byId.get(id);
  if (!index || !old) return;
  const resolved = { ...old, conflicted: false, status: old.status === 'U' ? 'M' : old.status };
  index.byId.set(id, resolved);
  const position = index.positions.get(id);
  if (position !== undefined) index.files[position] = resolved;
  index.signature = await indexSignature(mr);
  index.expiresAt = Date.now() + 1_000;
}
async function entries(mr: MergeRequest, signal?: AbortSignal): Promise<Entry[]> {
  if (!mr.worktree) return [];
  const output = await git(mr, ["ls-files", "--unmerged", "--stage", "-z"], {
    cwd: mr.worktree, signal,
  });
  return output.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const split = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, split).split(" ");
      return { mode: ownString(mode), oid: ownString(oid), stage: Number(stage), path: ownString(record.slice(split + 1)) };
    });
}
export async function listFiles(mr: MergeRequest, signal?: AbortSignal): Promise<MergeFileSummary[]> {
  if (!mr.worktree) return [];
  pruneIndexes();
  const cached = fileIndexes.get(mr.id);
  if (cached) { cached.accessedAt = Date.now(); fileIndexes.delete(mr.id); fileIndexes.set(mr.id, cached); }
  // Versioned cache keeps repeated single-file reads O(1). The expiry is a safety
  // check for an external Git process changing the index without a Synax version.
  if (cached && cached.expiresAt > Date.now()) return cached.files;
  const signature = await indexSignature(mr, signal);
  if (cached?.signature === signature) { cached.expiresAt = Date.now() + 1_000; return cached.files; }
  const staged = await entries(mr, signal);
  if (staged.length > MAX_INDEX_FILES * 4) throw new GitMrError('Merge file index exceeds the supported limit.', 'FILE_INDEX_LIMIT');
  const conflicts = new Set(
    staged.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
  );
  const diff = await git(
    mr,
    ["diff", "--name-status", "--no-renames", "-z", mr.targetOid, "--"],
    { cwd: mr.worktree, signal },
  );
  const pieces = diff.stdout.split("\0");
  const files = new Map<string, MergeFileSummary>();
  for (let i = 0; i < pieces.length - 1; i += 2) {
    const file = ownString(pieces[i + 1]);
    if (!file) continue;
    files.set(file, {
      id: fileId(file),
      path: file,
      status: pieces[i],
      conflicted: conflicts.has(file),
    });
  }
  for (const file of conflicts)
    files.set(file, {
      id: fileId(file),
      path: file,
      status: "U",
      conflicted: true,
    });
  if (files.size > MAX_INDEX_FILES) throw new GitMrError('Merge file list exceeds the supported limit.', 'FILE_INDEX_LIMIT');
  const sorted = [...files.values()].sort(
    (a, b) =>
      Number(b.conflicted) - Number(a.conflicted) ||
      a.path.localeCompare(b.path),
  );
  const grouped = new Map<string, Entry[]>();
  for (const entry of staged) { const group = grouped.get(entry.path); if (group) group.push(entry); else grouped.set(entry.path, [entry]); }
  const bytes = sorted.reduce((sum, file) => sum + 384 + 2 * (file.id.length + file.path.length), 0) + staged.reduce((sum, entry) => sum + 192 + 2 * (entry.path.length + entry.oid.length + entry.mode.length), 0);
  boundedIndex(mr, { bytes, accessedAt: Date.now(), files: sorted, byId: new Map(sorted.map(file => [file.id, file])), positions: new Map(sorted.map((file, index) => [file.id, index])), entries: grouped, signature, expiresAt: Date.now() + 1_000 });
  return sorted;
}
interface ContentSource {
  bytes: number;
  binary: boolean;
  digest: string;
  filename?: string;
  inline?: string;
  unavailable?: boolean;
  signature?: string;
}
interface BlobRecord { bytes: number; binary: boolean; digest: string; oid: string; accessedAt: number }
const contentRoot = path.join(DATA_ROOT, 'git-mr', 'content-cache');
const cacheLocks = new GitMrStore(path.join(DATA_ROOT, 'git-mr-content-locks'));
export const MAX_DISK_BLOB_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_DISK_BLOBS = 256;
const MAX_RESULT_METADATA = 64;
const blobFlights = new Map<string, Promise<ContentSource>>();
const contentOwners = new Map<string, Set<string>>();
const resultMetadata = new Map<string, { signature: string; source: ContentSource; accessedAt: number }>();
let cacheQueue: Promise<unknown> = Promise.resolve();
let cacheLockWaiters = 0;
const blobKey = (mr: MergeRequest, oid: string) => digest(`${mr.commonDir}\0${oid}`);
const blobFilename = (key: string) => path.join(contentRoot, `${key}.blob`);
const blobMetadataFilename = (key: string) => path.join(contentRoot, `${key}.json`);
function trackContent(mr: MergeRequest, key: string) {
  const owned = contentOwners.get(mr.id) ?? new Set<string>(); owned.add(key); contentOwners.set(mr.id, owned);
  while (contentOwners.size > 32) contentOwners.delete(contentOwners.keys().next().value!);
}
async function withCacheWriteLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try { return await cacheLocks.exclusive('content-cache', work); }
  catch (error) { if (!(error instanceof GitMrError) || error.code !== 'REPOSITORY_BUSY') throw error; }
  const directory = path.join(cacheLocks.directory, 'locks'); await fs.mkdir(directory, { recursive: true });
  let dirty = true, failure: unknown, wake: (() => void) | undefined;
  const notify = () => { dirty = true; wake?.(); wake = undefined; };
  const lockName = digest('content-cache');
  const observer = watch(directory, { persistent: false }, (_event, filename) => {
    // The lock helper briefly creates *.recovery while rejecting a live owner.
    // Ignore that self-generated event or waiters would retry continuously.
    if (!filename || String(filename) === lockName) notify();
  });
  cacheLockWaiters++;
  observer.on('error', error => { failure = error; notify(); });
  const onAbort = () => { failure = signal?.reason ?? new DOMException('Read cancelled.', 'AbortError'); notify(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => { failure = new GitMrError('Content cache writer did not release its lock.', 'CONTENT_READER_BUSY', 429); notify(); }, 30_000);
  try {
    for (;;) {
      if (signal?.aborted) onAbort(); if (failure) throw failure;
      dirty = false;
      try { return await cacheLocks.exclusive('content-cache', work); }
      catch (error) { if (!(error instanceof GitMrError) || error.code !== 'REPOSITORY_BUSY') throw error; }
      if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || failure) { wake = undefined; resolve(); } });
    }
  } finally { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); observer.close(); wake = undefined; cacheLockWaiters--; }
}
function queueCacheWrite<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const pending = cacheQueue.catch(() => undefined).then(() => withCacheWriteLock(work, signal));
  cacheQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
async function removeBlob(key: string) {
  const missingOkay = (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; };
  await Promise.all([fs.unlink(blobFilename(key)).catch(missingOkay), fs.unlink(blobMetadataFilename(key)).catch(missingOkay)]);
  for (const [mrId, keys] of contentOwners) { keys.delete(key); if (!keys.size) contentOwners.delete(mrId); }
}
async function pruneDiskCache(incomingBytes = 0) {
  await fs.mkdir(contentRoot, { recursive: true, mode: 0o700 });
  const names = await fs.readdir(contentRoot);
  if (names.length > MAX_DISK_BLOBS * 8) throw new GitMrError('Content cache requires cleanup before reading another large blob.', 'CACHE_LIMIT');
  const records: { key: string; bytes: number; accessedAt: number }[] = [];
  let bytes = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.blob$/.test(name)) continue;
    const key = name.slice(0, -5);
    const stat = await fs.stat(path.join(contentRoot, name)).catch(() => null);
    if (!stat) continue;
    const record = await fs.readFile(blobMetadataFilename(key), 'utf8').then(text => JSON.parse(text) as BlobRecord, () => null).catch(() => null);
    const accessedAt = Math.max(record?.accessedAt ?? 0, stat.mtimeMs);
    if (!record || !Number.isSafeInteger(record.bytes) || record.bytes !== stat.size || Date.now() - accessedAt >= CACHE_TTL_MS) { await removeBlob(key); continue; }
    bytes += record.bytes; records.push({ key, bytes: record.bytes, accessedAt });
  }
  records.sort((a, b) => a.accessedAt - b.accessedAt);
  let index = 0;
  while (bytes + incomingBytes > MAX_DISK_BLOB_CACHE_BYTES || records.length - index >= MAX_DISK_BLOBS) {
    const oldest = records[index++];
    if (!oldest) throw new GitMrError('Blob exceeds the shared disk cache budget.', 'CACHE_LIMIT');
    await removeBlob(oldest.key); bytes -= oldest.bytes;
  }
  // Temp files are bounded by the same admission lock; stale remnants are safe to remove.
  for (const name of names) if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name)) await fs.unlink(path.join(contentRoot, name)).catch(() => undefined);
}
async function cachedBlob(key: string, oid: string): Promise<ContentSource | undefined> {
  const metadata = await fs.readFile(blobMetadataFilename(key), 'utf8').then(text => JSON.parse(text) as BlobRecord, () => undefined).catch(() => undefined);
  if (!metadata || metadata.oid !== oid || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > MAX_BLOB_BYTES || !/^[a-f0-9]{64}$/.test(metadata.digest)) return undefined;
  const stat = await fs.stat(blobFilename(key)).catch(() => null);
  if (!stat || stat.size !== metadata.bytes || Date.now() - Math.max(metadata.accessedAt, stat.mtimeMs) >= CACHE_TTL_MS) return undefined;
  if (Date.now() - stat.mtimeMs >= 60_000) { const now = new Date(); await fs.utimes(blobFilename(key), now, now).catch(() => undefined); }
  return { bytes: metadata.bytes, binary: metadata.binary === true, digest: metadata.digest, filename: blobFilename(key) };
}
async function blobSource(mr: MergeRequest, oid: string | undefined, signal?: AbortSignal): Promise<ContentSource> {
  if (!oid) return { bytes: 0, binary: false, digest: digest(''), inline: '' };
  const key = blobKey(mr, oid);
  const cached = await cachedBlob(key, oid); if (cached) { trackContent(mr, key); return cached; }
  const existing = blobFlights.get(key); if (existing) return existing;
  const task = queueCacheWrite(async () => {
    const reused = await cachedBlob(key, oid); if (reused) return reused;
    const size = Number((await git(mr, ['cat-file', '-s', oid], { signal })).stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new GitMrError('Git returned an invalid blob size.', 'INVALID_CONTENT');
    if (size > MAX_BLOB_BYTES) return { bytes: size, binary: false, digest: oid, unavailable: true };
    await pruneDiskCache(size);
    const temporary = path.join(contentRoot, `${key}.${randomUUID()}.tmp`);
    const record = await spoolGitBlob(mr, oid, temporary, size, signal);
    await fs.rename(temporary, blobFilename(key));
    const metadata: BlobRecord = { ...record, oid, accessedAt: Date.now() };
    await fs.writeFile(blobMetadataFilename(key), JSON.stringify(metadata), { mode: 0o600 });
    return { ...record, filename: blobFilename(key) };
  }, signal);
  blobFlights.set(key, task);
  try { const result = await task; if (!result.unavailable) trackContent(mr, key); return result; } finally { if (blobFlights.get(key) === task) blobFlights.delete(key); }
}
const statSignature = (stat: import('node:fs').Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
async function worktreeSource(mr: MergeRequest, file: string, signal?: AbortSignal): Promise<ContentSource & { structural?: boolean }> {
  const filename = await safeWorktreeFile(mr, mr.worktree!, file);
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat) return { bytes: 0, binary: false, digest: digest(''), inline: '' };
  if (stat.isSymbolicLink()) { const inline = await fs.readlink(filename); return { bytes: Buffer.byteLength(inline), binary: false, digest: digest(inline), inline, structural: true }; }
  if (!stat.isFile()) return { bytes: 0, binary: false, digest: digest(''), inline: '', structural: true };
  const signature = statSignature(stat), key = `${mr.id}:${file}`;
  const cached = resultMetadata.get(key);
  if (cached?.signature === signature) { cached.accessedAt = Date.now(); return cached.source; }
  if (stat.size > MAX_BLOB_BYTES) return { bytes: stat.size, binary: false, digest: signature, filename, unavailable: true };
  let binary = false, readBytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true }), hash = createHash('sha256');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || statSignature(opened) !== signature) throw new GitMrError('The file changed before reading.', 'STALE_DRAFT');
    for await (const raw of handle.createReadStream({ highWaterMark: 64 * 1024, signal, autoClose: false })) {
      const chunk = raw as Buffer; readBytes += chunk.length;
      if (readBytes > stat.size) throw new GitMrError('The file grew while reading.', 'STALE_DRAFT');
      hash.update(chunk); if (chunk.includes(0)) binary = true;
      if (!binary) { try { decoder.decode(chunk, { stream: true }); } catch { binary = true; } }
    }
  } finally { await handle.close(); }
  if (!binary) { try { decoder.decode(); } catch { binary = true; } }
  const after = await fs.lstat(filename);
  if (statSignature(after) !== signature || readBytes !== stat.size) throw new GitMrError('The file changed during reading. Reload it.', 'STALE_DRAFT');
  const source = { bytes: stat.size, binary, digest: hash.digest('hex'), filename, signature };
  resultMetadata.delete(key); resultMetadata.set(key, { signature, source, accessedAt: Date.now() });
  for (const [oldKey, item] of resultMetadata) if (resultMetadata.size > MAX_RESULT_METADATA || Date.now() - item.accessedAt > CACHE_TTL_MS) resultMetadata.delete(oldKey);
  return source;
}
async function treeEntry(mr: MergeRequest, oid: string, file: string, signal?: AbortSignal) {
  const value = (await git(mr, ['ls-tree', '-z', oid, '--', file], { signal })).stdout;
  if (!value) return undefined;
  const [mode, , object] = value.slice(0, value.indexOf('\t')).split(' ');
  return { mode, oid: object };
}
async function fileContent(mr: MergeRequest, id: string, verifyIndex = false, signal?: AbortSignal) {
  if (verifyIndex && fileIndexes.get(mr.id)?.signature !== await indexSignature(mr, signal)) invalidateMergeFileIndex(mr.id);
  await listFiles(mr, signal);
  const cached = fileIndexes.get(mr.id), summary = cached?.byId.get(id);
  if (!summary || !mr.worktree) throw new GitMrError('File not found in this merge request.', 'NOT_FOUND', 404);
  const matches = cached?.entries.get(summary.path) ?? [];
  const step = mr.steps[mr.currentStep] ?? mr.steps.at(-1);
  const baseEntry = matches.find(entry => entry.stage === 1);
  const targetEntry = summary.conflicted ? matches.find(entry => entry.stage === 2) : await treeEntry(mr, mr.targetOid, summary.path, signal);
  const sourceEntry = summary.conflicted ? matches.find(entry => entry.stage === 3) : step ? await treeEntry(mr, step.oid, summary.path, signal) : undefined;
  const sources: ContentSource[] = [];
  for (const entry of [baseEntry, targetEntry, sourceEntry]) sources.push(entry?.mode === '160000'
    ? { bytes: entry.oid.length, binary: false, digest: entry.oid, inline: entry.oid }
    : await blobSource(mr, entry?.oid, signal));
  const working = await worktreeSource(mr, summary.path, signal); sources.push(working);
  const structural = working.structural || matches.some(entry => ['120000', '160000'].includes(entry.mode)) || (summary.conflicted && (!targetEntry || !sourceEntry));
  const kind = structural ? 'structural' : sources.some(source => source.binary) ? 'binary' : 'text';
  const revision = digest(JSON.stringify({ entries: matches, target: mr.targetOid, current: mr.currentStep, result: working.digest, size: working.bytes }));
  return { summary, sources, kind, revision, baseExists: !!baseEntry, targetExists: !!targetEntry, sourceExists: !!sourceEntry,
    reason: matches.some(entry => entry.mode === '160000') ? 'Submodule conflicts require an explicit gitlink decision outside the text editor.'
      : structural ? 'Structural conflict requires a whole-file decision.'
      : sources.some(source => source.unavailable) ? `Content exceeds the ${MAX_BLOB_BYTES / 1024 / 1024} MiB safety limit; use an external viewer.`
      : sources.some(source => source.bytes > MAX_VIEW_FILE_BYTES) ? 'Large text is shown in bounded read-only pages.'
      : sources.some(source => source.bytes > MAX_FILE_BYTES) ? 'Large text is available for browsing; direct text editing is limited to 2 MiB.' : undefined };
}
const sides = ['base', 'target', 'source', 'result'] as const;
async function sourceSlice(source: ContentSource, byteOffset: number, maxBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (source.unavailable) throw new GitMrError('This file exceeds the bounded content reader; use an external viewer.', 'FILE_TOO_LARGE');
  if (source.binary) throw new GitMrError('Binary files cannot be read as UTF-8 text.', 'UNSUPPORTED_CONFLICT');
  const start = Math.min(byteOffset, source.bytes);
  let bytes: Buffer;
  if (source.inline !== undefined) bytes = Buffer.from(source.inline, 'utf8').subarray(start, Math.min(source.bytes, start + maxBytes + 4));
  else {
    if (source.signature && statSignature(await fs.lstat(source.filename!)) !== source.signature) throw new GitMrError('The result changed before reading.', 'STALE_DRAFT');
    const handle = await fs.open(source.filename!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || source.signature && statSignature(opened) !== source.signature) throw new GitMrError('The content source changed before reading.', 'STALE_DRAFT');
      const buffer = Buffer.alloc(Math.min(source.bytes - start, maxBytes + 4)); const read = await handle.read(buffer, 0, buffer.length, start); bytes = buffer.subarray(0, read.bytesRead);
    }
    finally { await handle.close(); }
    if (source.signature && statSignature(await fs.lstat(source.filename!)) !== source.signature) throw new GitMrError('The result changed while reading.', 'STALE_DRAFT');
  }
  // Arbitrary offsets round forward to a valid UTF-8 start. Page-end never cuts a code point.
  let leading = 0; while (leading < bytes.length && (bytes[leading] & 0xc0) === 0x80) leading++;
  let end = Math.min(bytes.length, leading + maxBytes);
  while (end > leading && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(leading, end));
  const nextByteOffset = start + end;
  signal?.throwIfAborted();
  return { content, byteOffset: start + leading, nextByteOffset, totalBytes: source.bytes, eof: nextByteOffset >= source.bytes };
}
async function readFileContent(mr: MergeRequest, id: string, verifyIndex = false, signal?: AbortSignal): Promise<MergeFile> {
  const data = await fileContent(mr, id, verifyIndex, signal);
  const texts: string[] = [], truncatedSides: MergeFileSide[] = [];
  const aggregateTooLarge = data.sources.reduce((bytes, source) => bytes + source.bytes, 0) > 48 * 1024 * 1024;
  for (const [index, source] of data.sources.entries()) {
    const limit = aggregateTooLarge || source.bytes > MAX_VIEW_FILE_BYTES ? MAX_FILE_PREVIEW_BYTES : MAX_VIEW_FILE_BYTES;
    if (source.unavailable || source.binary) { texts.push(''); if (source.unavailable) truncatedSides.push(sides[index]); continue; }
    const slice = await sourceSlice(source, 0, limit, signal); texts.push(slice.content);
    if (!slice.eof) truncatedSides.push(sides[index]);
  }
  return { ...data.summary, kind: data.kind as MergeFile['kind'], base: texts[0], target: texts[1], source: texts[2], result: texts[3],
    revision: data.revision, baseExists: data.baseExists, targetExists: data.targetExists, sourceExists: data.sourceExists, reason: data.reason,
    contentState: truncatedSides.length ? 'partial' : 'complete', editable: data.kind === 'text' && data.sources.every(source => source.bytes <= MAX_FILE_BYTES),
    byteSizes: Object.fromEntries(sides.map((side, index) => [side, data.sources[index].bytes])) as Record<MergeFileSide, number>,
    truncatedSides, sliceLimitBytes: MAX_BLOB_BYTES };
}
export function readFile(mr: MergeRequest, id: string, verifyIndex = false, signal?: AbortSignal): Promise<MergeFile> {
  return withContentReadBudget(signal, () => readFileContent(mr, id, verifyIndex, signal));
}
async function readFileContentSlice(mr: MergeRequest, id: string, input: Omit<MergeFileSliceInput, 'expectedRevision'>, signal?: AbortSignal): Promise<MergeFileSlice> {
  if (!sides.includes(input.side) || !Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0 || !Number.isInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > MAX_FILE_SLICE_BYTES)
    throw new GitMrError('Invalid content slice.', 'INVALID_INPUT', 400);
  const data = await fileContent(mr, id, false, signal), source = data.sources[sides.indexOf(input.side)];
  const before = source.filename && input.side === 'result' ? await fs.stat(source.filename) : undefined;
  const slice = await sourceSlice(source, input.byteOffset, input.maxBytes, signal);
  if (before && statSignature(before) !== statSignature(await fs.stat(source.filename!))) throw new GitMrError('The result changed while reading a page.', 'STALE_DRAFT');
  return { ...slice, revision: data.revision };
}
export function readFileSlice(mr: MergeRequest, id: string, input: Omit<MergeFileSliceInput, 'expectedRevision'>, signal?: AbortSignal): Promise<MergeFileSlice> {
  return withContentReadBudget(signal, () => readFileContentSlice(mr, id, input, signal));
}
export async function releaseMergeFileCaches(mrId: string) {
  invalidateMergeFileIndex(mrId);
  for (const key of resultMetadata.keys()) if (key.startsWith(`${mrId}:`)) resultMetadata.delete(key);
  const owned = contentOwners.get(mrId); contentOwners.delete(mrId);
  if (!owned?.size) return;
  await queueCacheWrite(async () => { for (const key of owned) if (![...contentOwners.values()].some(keys => keys.has(key))) await removeBlob(key); });
}
/** Exposes budgets/counters only, never source data. Access also collects expired metadata. */
export function mergeFileCacheStats() {
  pruneIndexes();
  return { indexEntries: fileIndexes.size, indexBytes: indexCacheBytes, indexLimitBytes: MAX_FILE_INDEX_CACHE_BYTES,
    resultMetadataEntries: resultMetadata.size, inFlightBlobs: blobFlights.size, diskLimitBytes: MAX_DISK_BLOB_CACHE_BYTES,
    activeContentReads: Number(activeContentRead), queuedContentReads: contentWaiters.length, cacheLockWaiters };
}

export async function writeFile(
  mr: MergeRequest,
  id: string,
  input: MergeFileSave,
  guard?: () => Promise<void>,
) {
  if (mr.status !== "conflicted" || !mr.worktree)
    throw new GitMrError(
      "Only an active conflict can be edited.",
      "INVALID_STATE",
    );
  const file = await readFile(mr, id, true);
  if (!file.conflicted)
    throw new GitMrError("This file is already resolved.", "INVALID_STATE");
  if (file.revision !== input.expectedRevision)
    throw new GitMrError(
      "The file changed. Reload before applying this decision.",
      "STALE_DRAFT",
    );
  if (file.reason?.startsWith("Submodule"))
    throw new GitMrError(file.reason, "UNSUPPORTED_CONFLICT");
  const destination = await safeWorktreeFile(mr, mr.worktree, file.path);
  await guard?.();
  if (file.path.split('/').at(-1) === '.DS_Store') throw new GitMrError('.DS_Store must never be tracked.', 'BRANCH_POLICY');
  if (input.choice) {
    if (!input.resolve)
      throw new GitMrError(
        "Whole-file decisions must explicitly resolve the file.",
        "INVALID_INPUT",
        400,
      );
    const stage = input.choice === "target" ? 2 : 3;
    const exists =
      input.choice === "target" ? file.targetExists : file.sourceExists;
    if (input.choice === "delete" || !exists)
      await git(mr, ["rm", "-f", "--", file.path], { cwd: mr.worktree });
    else {
      await git(
        mr,
        ["checkout-index", `--stage=${stage}`, "--force", "--", file.path],
        { cwd: mr.worktree },
      );
      await git(mr, ["add", "--", file.path], { cwd: mr.worktree });
    }
  } else {
    if (file.kind === 'text' && file.editable === false) throw new GitMrError('This text exceeds the direct editing budget. It remains available through bounded read-only pages.', 'FILE_TOO_LARGE');
    if (file.kind !== "text")
      throw new GitMrError(
        "This file cannot be edited as text. Select a complete version.",
        "UNSUPPORTED_CONFLICT",
      );
    if (
      typeof input.content !== "string" ||
      Buffer.byteLength(input.content) > MAX_FILE_BYTES
    )
      throw new GitMrError(
        "Invalid or oversized file content.",
        "INVALID_INPUT",
        400,
      );
    if (input.resolve && /^(<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(input.content))
      throw new GitMrError(
        "Resolve every conflict marker before marking this file resolved.",
        "UNRESOLVED_CONTENT",
      );
    const stat = await fs.lstat(destination).catch(() => null);
    if (stat?.isSymbolicLink())
      throw new GitMrError(
        "Cannot write through a symbolic link.",
        "UNSAFE_PATH",
      );
    // Preserve the file mode and EOL bytes; never normalize or truncate result text.
    await guard?.();
    await fs.writeFile(destination, input.content, "utf8");
    if (input.resolve)
      await git(mr, ["add", "--", file.path], { cwd: mr.worktree });
  }
  if (input.resolve) await updateResolvedFileIndex(mr, id);
  return file;
}
