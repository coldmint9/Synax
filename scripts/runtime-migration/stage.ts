import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeSidecarClient } from '../../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import { historyPages, sessionPages } from '../../services/local-node/modules/agent-runtime/sidecar/history-pages.js';
import { historyTables, nativeProjection, nativeRow, type Row, type SessionBundle } from './records.js';
import { verifyV1Archive } from './archive.js';

async function* records(input: string): AsyncGenerator<Row> {
  const source = createReadStream(input);
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  try { for await (const line of lines) yield JSON.parse(line) as Row; }
  finally { lines.close(); source.destroy(); }
}
function projectionInput(session: Row): SessionBundle { return { session, tables: { agent_runtime_runs: [], agent_runtime_permissions: [], agent_runtime_interactions: [] } }; }
function projectRecord(item: SessionBundle, table: string, row: Row) {
  if (table === 'agent_runtime_runs') {
    const old = item.tables[table][0];
    if (!old || String(row.startedAt ?? '') >= String(old.startedAt ?? '')) item.tables[table] = [row];
  } else if (table === 'agent_runtime_permissions' && row.action === 'ask' && !row.resolvedAt) item.tables[table].push(row);
  else if (table === 'agent_runtime_interactions' && !row.consumedAt && (row.status === 'pending' || row.response != null)) item.tables[table].push(row);
}
const definition = (table: string) => historyTables[table as keyof typeof historyTables];
const decode = (value: Uint8Array): Row => JSON.parse(Buffer.from(value).toString('utf8')) as Row;
const globalCommand = async (client: RuntimeSidecarClient, requestId: string, operation: string, payload: unknown) =>
  decode(await client.historyCommandGlobal({ sessionId: '__migration_assets__', requestId, operation, payload }));

/** Stage real current heads and assets in an isolated Rust data root. Checkpoint
 * conversion is a separate outstanding cutover step, explicitly reported below. */
export async function stageV1Archive(input: string, client: RuntimeSidecarClient) {
  const source = await verifyV1Archive(input);
  let item: SessionBundle | undefined, batch: Array<{kind: string; value: Row}> = [], bytes = 0, batchId = 0;
  let sessions = 0, entities = 0, asset: Row | undefined, maxProjectionBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await client.historyCommand({ sessionId: String(item!.session.id), requestId: `v1-stage:${item!.session.id}:${batchId++}`,
      operation: 'append_entities', payload: { objects: batch } });
    batch = []; bytes = 0;
  };
  for await (const record of records(input)) {
    if (record.type === 'session') { item = projectionInput(record.value as Row); batchId = 0; }
    else if (record.type === 'record') {
      const table = String(record.table), config = definition(table);
      if (!config) throw new Error(`Native staging does not yet support ${table}`);
      const value = nativeRow(table, record.value as Row), object = { kind: config[0], value };
      const cost = Buffer.byteLength(JSON.stringify(object));
      if (cost > 750 * 1024) throw new Error(`Entity exceeds staging frame: ${table}:${value.id}`);
      if (batch.length && (bytes + cost > 750 * 1024 || batch.length === 256)) await flush();
      batch.push(object); bytes += cost; entities++;
      projectRecord(item!, table, value);
    } else if (record.type === 'session-end') {
      await flush();
      const snapshot = Buffer.from(JSON.stringify(nativeProjection(item!)));
      maxProjectionBytes = Math.max(maxProjectionBytes, snapshot.length);
      await client.importProjection(String(item!.session.id), snapshot);
      item = undefined; sessions++;
      if (sessions % 25 === 0) console.error(JSON.stringify({ stagedSessions: sessions, entities }));
    } else if (record.type === 'asset') {
      asset = record.value as Row;
      await globalCommand(client, `asset:${asset.id}`, 'asset_put', { asset });
    } else if (record.type === 'asset-chunk') {
      const chunk = Buffer.from(String(record.bytesBase64), 'base64');
      await globalCommand(client, `blob:${asset!.id}:${record.index}`, 'put_blob_chunk', {
        blobId: asset!.id, index: record.index, total: Math.ceil(Number(asset!.size) / (256 * 1024)), bytesHex: chunk.toString('hex'),
      });
    } else if (record.type === 'asset-end') {
      await globalCommand(client, `blob-manifest:${asset!.id}`, 'put_blob_manifest', { blobId: asset!.id, total: record.chunks, size: asset!.size, sha256: asset!.sha256 });
      asset = undefined;
    } else if (record.type === 'asset-binding') {
      const binding = record.value as Row;
      await globalCommand(client, `bind:${binding.sessionId}:${binding.assetId}`, 'asset_bind', binding);
    }
  }
  return { staged: true, cutoverComplete: false, sessions, entities, assets: source.assets, assetBytes: source.assetBytes,
    maxProjectionBytes, pendingCheckpointConversion: source.checkpoints, retainedSourceObjects: source.objects };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Expected records are reduced to per-id hashes, then compared to native pages.
 * Full metadata bodies never accumulate in the verifier's working set. */
export async function verifyV1Stage(input: string, client: RuntimeSidecarClient) {
  const started = performance.now();
  await verifyV1Archive(input);
  let item: SessionBundle | undefined, expected = new Map<string, Map<string, string>>();
  let sessions = 0, entities = 0, assets = 0, assetBytes = 0, assetBindings = 0, maxPageBytes = 0;
  let projectedSessionBytes = 0;
  const expectedSessions = new Map<string, string>();
  for await (const record of records(input)) {
    if (record.type === 'session') { item = projectionInput(record.value as Row); expected = new Map(); }
    else if (record.type === 'record') {
      const table = String(record.table), value = nativeRow(table, record.value as Row);
      let rows = expected.get(table); if (!rows) { rows = new Map(); expected.set(table, rows); }
      rows.set(String(value.id), digest(value));
      projectRecord(item!, table, value);
    } else if (record.type === 'session-end') {
      const sessionId = String(item!.session.id);
      for (const [table, [, operation]] of Object.entries(historyTables)) {
        const wanted = expected.get(table) ?? new Map<string, string>();
        for await (const page of historyPages<Row>(client, sessionId, operation)) {
          maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
          for (const value of page) {
            const id = String(value.id);
            if (wanted.get(id) !== digest(value)) throw new Error(`Native staged entity differs: ${sessionId}:${table}:${id}`);
            wanted.delete(id); entities++;
          }
        }
        if (wanted.size) throw new Error(`Native staging omitted ${wanted.size} ${table} records from ${sessionId}`);
      }
      const projection = nativeProjection(item!);
      const actual = decode(await client.uiSnapshot(sessionId));
      projectedSessionBytes += Buffer.byteLength(JSON.stringify(actual.session));
      if (!isDeepStrictEqual(actual.session, projection.session)) throw new Error(`Native staged session differs: ${sessionId}`);
      expectedSessions.set(sessionId, digest(projection.session));
      const hot = await client.snapshot(sessionId);
      const control = decode((await client.controlCommand({ sessionId, requestId: `verify-stage:${sessionId}`, operation: 'read', epoch: hot.epoch, revision: hot.revision })).stateJson);
      if (!isDeepStrictEqual(control.permissions, projection.control.permissions) || !isDeepStrictEqual(control.interactions, projection.control.interactions)) throw new Error(`Native pending controls differ: ${sessionId}`);
      sessions++;
      if (sessions % 25 === 0) console.error(JSON.stringify({ verifiedSessions: sessions, entities }));
    } else if (record.type === 'asset') {
      const asset = record.value as Row;
      const actual = await globalCommand(client, `verify-asset:${asset.id}`, 'asset_get', { assetId: asset.id });
      if (!isDeepStrictEqual(actual, asset)) throw new Error(`Native asset metadata differs: ${asset.id}`);
      assets++;
    } else if (record.type === 'asset-chunk') {
      const actual = await globalCommand(client, `verify-blob:${record.assetId}:${record.index}`, 'get_blob_chunk', { blobId: record.assetId, index: record.index });
      const bytes = Buffer.from(String(record.bytesBase64), 'base64');
      if (actual.bytesHex !== bytes.toString('hex')) throw new Error(`Native asset bytes differ: ${record.assetId}:${record.index}`);
      assetBytes += bytes.length;
    } else if (record.type === 'asset-binding') {
      const actual = await globalCommand(client, `verify-bind:${(record.value as Row).assetId}:${(record.value as Row).sessionId}`, 'asset_has_binding', record.value);
      if (actual.bound !== true) throw new Error('Native asset binding missing');
      assetBindings++;
    }
  }
  let maxSessionPageBytes = 0;
  for await (const page of sessionPages<Row>(client)) {
    maxSessionPageBytes = Math.max(maxSessionPageBytes, Buffer.byteLength(JSON.stringify(page)));
    for (const session of page) {
      if (expectedSessions.get(String(session.id)) !== digest(session)) throw new Error(`Native session list differs: ${session.id}`);
      expectedSessions.delete(String(session.id));
    }
  }
  if (expectedSessions.size) throw new Error('Native session list omitted imported sessions');
  return { ok: true, scope: 'staged current heads, pending controls and asset files; checkpoint conversion outstanding', sessions, entities, assets, assetBytes, assetBindings, maxPageBytes, maxSessionPageBytes, projectedSessionBytes, elapsedMs: Math.round(performance.now() - started) };
}
