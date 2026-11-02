import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { DATA_ROOT } from '../../../infrastructure/runtime/env.js';
import { logger } from '../../../infrastructure/runtime/logger.js';
import {
  compactDocument,
  decodeDocument,
  encodeDocument,
  type SessionSearchDocument,
  type StoredDocument,
} from './search-documents.js';

/**
 * The index is a cache, never the source of truth: a missing, stale or damaged
 * file only costs a rebuild from the runtime history. Compression keeps the
 * stored text well under the JSONL transcripts it summarizes.
 */
const STORE_VERSION = 1;
const STORE_DIRECTORY = 'session-search';

/** Upper bound on the cache; overflow keeps labels and drops message text. */
export const MAX_STORED_DOCUMENTS = 600;
export const MAX_STORED_CHARS = 4_000_000;

interface StoredFile {
  version: number;
  projectId: string;
  savedAt: string;
  documents: StoredDocument[];
}

export interface SessionSearchStore {
  load(projectId: string): Promise<SessionSearchDocument[]>;
  save(
    projectId: string,
    documents: readonly SessionSearchDocument[],
  ): Promise<void>;
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Newest first; the budget keeps the conversations most likely to be searched. */
export function boundDocuments(
  documents: readonly SessionSearchDocument[],
  budget = MAX_STORED_CHARS,
): SessionSearchDocument[] {
  const ordered = documents
    .slice()
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.sessionId.localeCompare(left.sessionId),
    );
  const kept: SessionSearchDocument[] = [];
  let chars = 0;
  for (const document of ordered) {
    if (kept.length >= MAX_STORED_DOCUMENTS) break;
    if (chars + document.chars <= budget) {
      kept.push(document);
      chars += document.chars;
      continue;
    }
    // Over budget: keep the label and prompt searchable instead of dropping the
    // session, so it neither disappears from results nor gets re-read forever.
    const compacted = document.segments.some(
      (segment) => segment.kind === 'message',
    )
      ? compactDocument(document)
      : null;
    if (!compacted || chars + compacted.chars > budget) continue;
    kept.push(compacted);
    chars += compacted.chars;
  }
  return kept;
}

export class FileSessionSearchStore implements SessionSearchStore {
  constructor(
    private readonly directory = path.join(DATA_ROOT, STORE_DIRECTORY),
  ) {}

  /** One file per workspace, so an active workspace never rewrites the others. */
  private file(projectId: string): string {
    const digest = createHash('sha1').update(projectId).digest('hex');
    return path.join(this.directory, `${digest.slice(0, 24)}.json.gz`);
  }

  async load(projectId: string): Promise<SessionSearchDocument[]> {
    let raw: Buffer;
    try {
      raw = await readFile(this.file(projectId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const parsed = JSON.parse((await gunzipAsync(raw)).toString('utf8')) as StoredFile;
      if (
        parsed?.version !== STORE_VERSION ||
        parsed.projectId !== projectId ||
        !Array.isArray(parsed.documents)
      )
        return [];
      const documents: SessionSearchDocument[] = [];
      for (const stored of parsed.documents) {
        const document = decodeDocument(stored);
        if (document) documents.push(document);
      }
      // Never let a hand-edited or older file exceed the in-memory budget.
      return boundDocuments(documents);
    } catch (error) {
      logger.warn(
        { projectId, err: error },
        '[session-search] ignoring an unreadable index file',
      );
      return [];
    }
  }

  async save(
    projectId: string,
    documents: readonly SessionSearchDocument[],
  ): Promise<void> {
    const payload: StoredFile = {
      version: STORE_VERSION,
      projectId,
      savedAt: new Date().toISOString(),
      documents: boundDocuments(documents).map(encodeDocument),
    };
    const bytes = await gzipAsync(JSON.stringify(payload));
    await mkdir(this.directory, { recursive: true });
    const target = this.file(projectId);
    // A crashed write must never leave a half file behind: publish by rename.
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
}

/** Test double: keeps the store contract in memory. */
export class MemorySessionSearchStore implements SessionSearchStore {
  private readonly files = new Map<string, SessionSearchDocument[]>();

  async load(projectId: string): Promise<SessionSearchDocument[]> {
    return (this.files.get(projectId) ?? []).slice();
  }

  async save(
    projectId: string,
    documents: readonly SessionSearchDocument[],
  ): Promise<void> {
    this.files.set(projectId, boundDocuments(documents).slice());
  }

  documents(projectId: string): readonly SessionSearchDocument[] {
    return this.files.get(projectId) ?? [];
  }
}
