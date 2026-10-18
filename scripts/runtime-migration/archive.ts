import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { V1Reader } from './v1-reader.js';
import type { Row } from './records.js';

export const archiveFormat = 'synax.runtime.v1-source-archive.1';
export interface ArchiveCounts { sessions: number; records: number; checkpoints: number; objects: number; assets: number; assetBytes: number; assetBindings: number }
const emptyCounts = (): ArchiveCounts => ({ sessions: 0, records: 0, checkpoints: 0, objects: 0, assets: 0, assetBytes: 0, assetBindings: 0 });

/** 1 MiB write buffers, one decoded entity at a time. No full-session arrays. */
export async function exportV1Archive(dataRoot: string, database: string, output: string) {
  const reader = new V1Reader(dataRoot, database);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(output), { recursive: true });
  const file = await open(temporary, 'wx', 0o600);
  const digest = createHash('sha256'), counts = emptyCounts();
  let buffer: string[] = [], bufferBytes = 0;
  const flush = async () => {
    if (!buffer.length) return;
    await file.writeFile(buffer.join('')); buffer = []; bufferBytes = 0;
  };
  const write = async (record: Row, checksum = true) => {
    const line = JSON.stringify(record) + '\n';
    if (checksum) digest.update(line);
    buffer.push(line); bufferBytes += Buffer.byteLength(line);
    if (bufferBytes >= 1024 * 1024) await flush();
  };
  try {
    await write({ type: 'header', format: archiveFormat, createdAt: new Date().toISOString(), database,
      scope: 'visible native entities, retained immutable history graph, asset files and bindings' });
    for (const session of reader.sessions()) {
      await write({ type: 'session', sessionId: session.id, mode: session.mode, value: session.session,
        sourceHead: session.head ? { ...session.head, version_id: Buffer.from(session.head.version_id).toString('hex'),
          checkpoint_root: session.head.checkpoint_root ? Buffer.from(session.head.checkpoint_root as Uint8Array).toString('hex') : null,
          checkpoint_identity_root: session.head.checkpoint_identity_root ? Buffer.from(session.head.checkpoint_identity_root as Uint8Array).toString('hex') : null,
          _metadata: undefined } : null });
      for (const record of reader.records(session)) { await write({ type: 'record', sessionId: session.id, ...record }); counts.records++; }
      for (const checkpoint of reader.checkpoints(session)) { await write({ type: 'checkpoint', sessionId: session.id, value: checkpoint }); counts.checkpoints++; }
      await write({ type: 'session-end', sessionId: session.id });
      counts.sessions++;
      if (counts.sessions % 25 === 0) console.error(JSON.stringify({ exportedSessions: counts.sessions, records: counts.records }));
    }
    for (const object of reader.retainedObjects()) { await write({ type: 'object', ...object }); counts.objects++; }
    for (const asset of reader.assets()) {
      await write({ type: 'asset', value: asset });
      let index = 0;
      for (const chunk of reader.assetChunks(asset)) {
        await write({ type: 'asset-chunk', assetId: asset.id, index: index++, bytesBase64: chunk.toString('base64') });
        counts.assetBytes += chunk.length;
      }
      await write({ type: 'asset-end', assetId: asset.id, chunks: index }); counts.assets++;
    }
    for (const value of reader.assetBindings()) { await write({ type: 'asset-binding', value }); counts.assetBindings++; }
    await write({ type: 'footer', counts, sha256: digest.digest('hex') }, false);
    await flush(); await file.sync(); await file.close();
    await rename(temporary, output);
    return counts;
  } catch (error) {
    await file.close(); await rm(temporary, { force: true }); throw error;
  } finally { reader.close(); }
}

/** Verify exported bytes independently of the source database and runtime. */
export async function verifyV1Archive(input: string): Promise<ArchiveCounts> {
  const source = createReadStream(input);
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  const digest = createHash('sha256'), counts = emptyCounts();
  let lineNumber = 0, footer = false, sessionId: string | undefined;
  let asset: { id: string; size: number; sha256: string; bytes: number; chunks: number; hash: ReturnType<typeof createHash> } | undefined;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (footer) throw new Error('Data follows archive footer');
      const record = JSON.parse(line);
      if (lineNumber === 1 && (record.type !== 'header' || record.format !== archiveFormat)) throw new Error('Unsupported V1 archive');
      if (record.type !== 'footer') digest.update(line).update('\n');
      switch (record.type) {
        case 'header': if (lineNumber !== 1) throw new Error('Duplicate archive header'); break;
        case 'session':
          if (sessionId || !record.sessionId || record.value?.id !== record.sessionId) throw new Error('Invalid archive session');
          sessionId = record.sessionId; counts.sessions++; break;
        case 'record': case 'checkpoint':
          if (!sessionId || record.sessionId !== sessionId) throw new Error('Record outside its archive session');
          if (record.value?.sessionId !== sessionId) throw new Error('Archive record belongs to another session');
          if (record.type === 'record') counts.records++; else counts.checkpoints++;
          break;
        case 'session-end':
          if (!sessionId || record.sessionId !== sessionId) throw new Error('Invalid archive session end');
          sessionId = undefined; break;
        case 'object': {
          const bytes = Buffer.from(record.bytesBase64, 'base64');
          const identity = createHash('sha256').update(`synax.checkpoint.v3\0${record.kind}\0${bytes.length}\0`).update(bytes).update('\0').update(record.refs.join(',')).digest('hex');
          if (identity !== record.id) throw new Error('Archive object checksum mismatch');
          counts.objects++; break;
        }
        case 'asset':
          if (asset) throw new Error('Nested archive asset');
          asset = { ...record.value, bytes: 0, chunks: 0, hash: createHash('sha256') }; break;
        case 'asset-chunk': {
          if (!asset || asset.id !== record.assetId || record.index !== asset.chunks++) throw new Error('Archive asset chunk order mismatch');
          const bytes = Buffer.from(record.bytesBase64, 'base64');
          asset.bytes += bytes.length; asset.hash.update(bytes); break;
        }
        case 'asset-end':
          if (!asset || asset.id !== record.assetId || record.chunks !== asset.chunks || asset.bytes !== asset.size || asset.hash.digest('hex') !== asset.sha256) throw new Error('Archive asset checksum mismatch');
          counts.assets++; counts.assetBytes += asset.bytes; asset = undefined; break;
        case 'asset-binding': counts.assetBindings++; break;
        case 'footer':
          if (sessionId || asset || digest.digest('hex') !== record.sha256 || JSON.stringify(counts) !== JSON.stringify(record.counts)) throw new Error('Archive footer verification failed');
          footer = true; break;
        default: throw new Error('Unknown archive record');
      }
    }
    if (!footer) throw new Error('V1 archive is incomplete: footer missing');
    return counts;
  } finally { lines.close(); source.destroy(); }
}
