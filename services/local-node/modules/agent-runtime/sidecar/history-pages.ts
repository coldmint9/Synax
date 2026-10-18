import { randomUUID } from 'node:crypto';
import type { RuntimeSidecarClient } from './sidecar-client.js';

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

/** Each reply is a byte-bounded Rust index page tied to one head revision. */
export async function* historyPages<T>(
  client: RuntimeSidecarClient, sessionId: string, operation: string,
  options: { global?: boolean; reverse?: boolean; limit?: number } = {},
): AsyncGenerator<T[]> {
  let cursor: unknown;
  do {
    const input = { sessionId, requestId: randomUUID(), operation,
      payload: { cursor, reverse: options.reverse, limit: options.limit } };
    const bytes = options.global ? await client.historyCommandGlobal(input) : await client.historyCommand(input);
    const page = JSON.parse(Buffer.from(bytes).toString('utf8')) as { items: T[]; cursor?: unknown };
    yield page.items;
    cursor = page.cursor;
  } while (cursor);
}

export async function readHistoryList<T>(
  client: RuntimeSidecarClient, sessionId: string, operation: string,
  options: { global?: boolean; reverse?: boolean; limit?: number } = {},
): Promise<T[]> {
  const items: T[] = [];
  for await (const page of historyPages<T>(client, sessionId, operation, options)) items.push(...page);
  return items;
}
