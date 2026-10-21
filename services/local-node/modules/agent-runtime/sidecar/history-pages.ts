import { randomUUID } from 'node:crypto';
import { RuntimeSidecarError, type RuntimeSidecarClient } from './sidecar-client.js';

const MAX_HISTORY_READ_RESTARTS = 7;
const HISTORY_PAGE_MAX_BYTES = 768 * 1024;
const HISTORY_OBJECT_MAX_BYTES = 4 * 1024 * 1024;

function isRevisionConflict(error: unknown): error is RuntimeSidecarError {
  return error instanceof RuntimeSidecarError && error.code === 'REVISION_CONFLICT';
}

export async function* sessionPages<T>(client: RuntimeSidecarClient): AsyncGenerator<T[]> {
  let after: string | undefined;
  do {
    const page = JSON.parse(Buffer.from(await client.sessionList(after)).toString('utf8')) as { items: T[]; next?: string };
    yield page.items; after = page.next;
  } while (after);
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
      const maxBytes = declaredBytes ?? HISTORY_OBJECT_MAX_BYTES;
      const chunks: string[] = [];
      let offset = 0;
      while (true) {
        const input = { sessionId, requestId: randomUUID(), operation: 'object_value_chunk', payload: { objectId: value.$historyObject, offset } };
        const bytes = global ? await client.historyCommandGlobal(input) : await client.historyCommand(input);
        const page = JSON.parse(Buffer.from(bytes).toString('utf8')) as { text: string; next?: number | null };
        if (typeof page?.text !== 'string') throw new Error('History object chunk did not advance.');
        const end = offset + Buffer.byteLength(page.text);
        if (end > maxBytes || (page.next != null && (page.next !== end || end <= offset || end >= maxBytes)))
          throw new Error('History object chunk did not advance.');
        chunks.push(page.text);
        offset = end;
        if (page.next == null) break;
      }
      if (declaredBytes !== undefined && offset !== declaredBytes) throw new Error('History object chunk is incomplete.');
      result[index] = JSON.parse(chunks.join('')) as T;
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
