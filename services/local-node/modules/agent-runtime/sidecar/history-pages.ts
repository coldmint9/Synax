import { randomUUID } from 'node:crypto';
import { RuntimeSidecarError, type RuntimeSidecarClient } from './sidecar-client.js';

const MAX_HISTORY_READ_RESTARTS = 7;
const HISTORY_PAGE_MAX_BYTES = 768 * 1024;
const HISTORY_OBJECT_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_CACHE_MAX_ENTRIES = 1024;

type EncodedObject = { text: string; bytes: number };
type ObjectCache = {
  bytes: number;
  values: Map<string, EncodedObject>;
  pending: Map<string, Promise<EncodedObject>>;
};
const objectCaches = new WeakMap<RuntimeSidecarClient, ObjectCache>();

async function readHistoryObject(
  client: RuntimeSidecarClient, sessionId: string, objectId: string, global: boolean,
): Promise<EncodedObject> {
  let cache = objectCaches.get(client);
  if (!cache) objectCaches.set(client, cache = { bytes: 0, values: new Map(), pending: new Map() });
  const key = JSON.stringify([sessionId, objectId]);
  const cached = cache.values.get(key);
  if (cached) {
    cache.values.delete(key);
    cache.values.set(key, cached);
    return cached;
  }
  const pending = cache.pending.get(key);
  if (pending) return pending;
  const read = transferObject(client, sessionId, async () => {
    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const input = { sessionId, requestId: randomUUID(), operation: 'object_value_chunk', payload: { objectId, offset } };
      const bytes = global ? await client.historyCommandGlobal(input) : await client.historyCommand(input);
      const page = JSON.parse(Buffer.from(bytes).toString('utf8')) as { text: string; next?: number | null };
      if (typeof page?.text !== 'string') throw new Error('History object chunk did not advance.');
      const end = offset + Buffer.byteLength(page.text);
      if (end > HISTORY_OBJECT_MAX_BYTES || (page.next != null &&
          (page.next !== end || end <= offset || end >= HISTORY_OBJECT_MAX_BYTES)))
        throw new Error('History object chunk did not advance.');
      chunks.push(page.text);
      offset = end;
      if (page.next == null) break;
    }
    const result = { text: chunks.join(''), bytes: offset };
    // Cache only complete immutable CAS objects. Store text so projections and
    // callers can mutate their decoded copy without corrupting another reader.
    JSON.parse(result.text);
    const cost = 2 * (key.length + result.text.length);
    while (cache.values.size && (cache.values.size >= HISTORY_CACHE_MAX_ENTRIES || cache.bytes + cost > HISTORY_CACHE_MAX_BYTES)) {
      const [oldKey, old] = cache.values.entries().next().value!;
      cache.values.delete(oldKey);
      cache.bytes -= 2 * (oldKey.length + old.text.length);
    }
    if (cost <= HISTORY_CACHE_MAX_BYTES) {
      cache.values.set(key, result);
      cache.bytes += cost;
    }
    return result;
  }).finally(() => { cache.pending.delete(key); });
  cache.pending.set(key, read);
  return read;
}

type Transfers = { active: number; waiting: Array<() => void> };
const transfers = new WeakMap<RuntimeSidecarClient, Map<string, Transfers>>();

/** Rust retains two encoded objects per session. Limit whole transfers, not
 * individual chunks, across concurrent window/environment/history readers. */
async function transferObject<T>(client: RuntimeSidecarClient, sessionId: string, read: () => Promise<T>): Promise<T> {
  let sessions = transfers.get(client);
  if (!sessions) transfers.set(client, sessions = new Map());
  let state = sessions.get(sessionId);
  if (!state) sessions.set(sessionId, state = { active: 0, waiting: [] });
  if (state.active >= 2) await new Promise<void>(resolve => state.waiting.push(resolve));
  else state.active++;
  try { return await read(); }
  finally {
    const next = state.waiting.shift();
    if (next) next();
    else if (--state.active === 0) sessions.delete(sessionId);
  }
}

function isRevisionConflict(error: unknown): error is RuntimeSidecarError {
  return error instanceof RuntimeSidecarError && error.code === 'REVISION_CONFLICT';
}

export async function* sessionPages<T>(client: RuntimeSidecarClient, signal?: AbortSignal): AsyncGenerator<T[]> {
  let after: string | undefined;
  while (true) {
    signal?.throwIfAborted();
    const page = JSON.parse(Buffer.from(await client.sessionList(after)).toString('utf8')) as { items: T[]; next?: string; loading?: boolean };
    if (page.loading) {
      // Each IPC request stays short while Rust builds the index in the background.
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      continue;
    }
    signal?.throwIfAborted();
    yield page.items; after = page.next;
    if (!after) break;
  }
}

export async function readSessionList<T>(client: RuntimeSidecarClient): Promise<T[]> {
  const items: T[] = [];
  for await (const page of sessionPages<T>(client)) items.push(...page);
  return items;
}

/** Large values travel as immutable references, then bounded UTF-8 JSON chunks.
 * Never skip or truncate a durable record to make an IPC frame fit. */
export async function hydrateHistoryValues<T>(
  client: RuntimeSidecarClient, sessionId: string, values: T[], global = false,
): Promise<T[]> {
  const result = [...values];
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      const value = values[index] as { $historyObject?: string; bytes?: number } | null;
      if (!value || typeof value.$historyObject !== 'string') continue;
      // Older history_sync replies omitted bytes, unlike list_* replies.
      // Read those references to their terminal chunk with the same hard cap;
      // a supplied size still has to match the complete UTF-8 JSON exactly.
      const declaredBytes = value.bytes;
      if (declaredBytes !== undefined &&
          (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > HISTORY_OBJECT_MAX_BYTES))
        throw new Error('Invalid history object size.');
      const encoded = await readHistoryObject(client, sessionId, value.$historyObject, global);
      if (declaredBytes !== undefined && encoded.bytes !== declaredBytes)
        throw new Error('History object chunk is incomplete.');
      result[index] = JSON.parse(encoded.text) as T;
    }
  };
  await Promise.all([worker(), worker()]);
  return result;
}

/** Each reply is a byte-bounded Rust index page tied to one head revision. */
export async function* historyPages<T>(
  client: RuntimeSidecarClient, sessionId: string, operation: string,
  options: { global?: boolean; reverse?: boolean; limit?: number; maxBytes?: number } = {},
): AsyncGenerator<T[]> {
  let cursor: unknown;
  do {
    const input = { sessionId, requestId: randomUUID(), operation,
      payload: {
        cursor,
        reverse: options.reverse,
        limit: options.limit,
        maxBytes: options.maxBytes ?? HISTORY_PAGE_MAX_BYTES,
        chunked: true,
      } };
    const bytes = options.global ? await client.historyCommandGlobal(input) : await client.historyCommand(input);
    const page = JSON.parse(Buffer.from(bytes).toString('utf8')) as { items: T[]; cursor?: unknown };
    yield await hydrateHistoryValues(client, sessionId, page.items, options.global);
    if (page.cursor && JSON.stringify(page.cursor) === JSON.stringify(cursor))
      throw new Error('History cursor did not advance.');
    cursor = page.cursor;
  } while (cursor);
}

export async function readHistoryList<T>(
  client: RuntimeSidecarClient, sessionId: string, operation: string,
  options: { global?: boolean; reverse?: boolean; limit?: number; maxBytes?: number } = {},
): Promise<T[]> {
  // History cursors are intentionally tied to the head revision so a paged
  // read cannot silently mix two versions of a transcript. A live session can
  // advance that revision between pages, so restart the complete read on the
  // conflict and only expose a result after every page came from one head.
  for (let attempt = 0; ; attempt++) {
    const items: T[] = [];
    try {
      for await (const page of historyPages<T>(client, sessionId, operation, options)) {
        items.push(...page);
      }
      return items;
    } catch (error) {
      if (!isRevisionConflict(error) || attempt >= MAX_HISTORY_READ_RESTARTS) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25 * 2 ** attempt, 500)),
      );
    }
  }
}
