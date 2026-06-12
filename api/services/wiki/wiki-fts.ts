// ---------------------------------------------------------------------------
// api/services/wiki/wiki-fts.ts — FTS5 全文搜索服务（document-level）
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import { wikiDocuments } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

// ── CJK character separation ────────────────────────────────────────────────

const CJK_RANGES: Array<[number, number]> = [
  [0x4E00, 0x9FFF],
  [0x3400, 0x4DBF],
  [0xF900, 0xFAFF],
];

function isCJK(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function cjkSeparate(text: string): string {
  let result = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    result += isCJK(cp) ? ' ' + ch + ' ' : ch;
  }
  return result.replace(/\s+/g, ' ').trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '');
}

/** Extract searchable plaintext from document markdown with CJK tokenization. */
export function extractSearchText(contentMd: string): string {
  if (!contentMd) return '';
  return cjkSeparate(stripMarkdown(contentMd));
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface WikiSearchResult {
  documentId: string;
  snippet: string;
  rank: number;
}

export interface WikiSearchOptions {
  projectId: string;
  query: string;
  limit?: number;
  documentId?: string;
}

export function searchWikiDocuments(opts: WikiSearchOptions): WikiSearchResult[] {
  const { projectId, query, limit = 50, documentId } = opts;
  const sqlite = getRawSqlite();

  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const ftsQuery = cjkSeparate(trimmed);

  const ftsExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_documents_fts'")
    .get() as { name: string } | undefined;

  if (!ftsExists) {
    logger.warn({ projectId, query: trimmed }, '[wiki-fts] FTS table missing — index may not have been built yet');
    return [];
  }

  const ftsCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_documents_fts').get() as { n: number }).n;
  if (ftsCount === 0) {
    logger.warn({ projectId, query: trimmed }, '[wiki-fts] FTS table exists but is empty — rebuild may have failed');
    return [];
  }

  let sql: string;
  let params: unknown[];

  if (documentId) {
    sql = `
      SELECT
        d.id AS document_id,
        d.search_text,
        fts.rank
      FROM wiki_documents_fts fts
      JOIN wiki_documents d ON d.id = fts.document_id
      WHERE wiki_documents_fts MATCH ?
        AND d.project_id = ?
        AND d.id = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [ftsQuery, projectId, documentId, limit];
  } else {
    sql = `
      SELECT
        d.id AS document_id,
        d.search_text,
        fts.rank
      FROM wiki_documents_fts fts
      JOIN wiki_documents d ON d.id = fts.document_id
      WHERE wiki_documents_fts MATCH ?
        AND d.project_id = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [ftsQuery, projectId, limit];
  }

  let rows: Array<{ document_id: string; search_text: string; rank: number }>;
  try {
    rows = sqlite.prepare(sql).all(...params) as typeof rows;
  } catch (err) {
    logger.warn({ err, projectId, query: trimmed, ftsQuery }, '[wiki-fts] search MATCH query failed');
    return [];
  }

  if (rows.length === 0) {
    logger.warn({ projectId, query: trimmed, ftsQuery, ftsCount }, '[wiki-fts] MATCH returned no results');
  }

  return rows.map(r => ({
    documentId: r.document_id,
    snippet: generateSnippet(r.search_text, trimmed),
    rank: r.rank,
  }));
}

/** @deprecated Use searchWikiDocuments */
export const searchWikiBlocks = searchWikiDocuments;

function generateSnippet(text: string, query: string, contextChars = 80): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const ftsQueryLower = cjkSeparate(query).toLowerCase();

  let idx = lower.indexOf(ftsQueryLower);
  let matchLen = ftsQueryLower.length;
  if (idx === -1) {
    idx = lower.indexOf(queryLower);
    matchLen = queryLower.length;
  }
  if (idx === -1) return text.slice(0, contextChars * 2);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + matchLen + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ── Index Rebuild ───────────────────────────────────────────────────────────

export async function rebuildWikiFtsIndex(): Promise<{ indexed: number }> {
  const sqlite = getRawSqlite();
  const db = getDb();

  let ftsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_documents_fts'")
    .get() as { name: string } | undefined;

  if (!ftsTable) {
    logger.info('[wiki-fts] FTS table does not exist yet, skipping rebuild');
    return { indexed: 0 };
  }

  let needsRecreate = false;
  try {
    const createSql = (sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_documents_fts'"
    ).get() as { sql: string }).sql;
    if (!createSql.includes('unicode61')) {
      logger.info('[wiki-fts] tokenizer changed — recreating FTS table as unicode61');
      needsRecreate = true;
    }
  } catch { /* table might be corrupted */ }

  if (!needsRecreate) {
    try {
      sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_documents_fts').get();
    } catch (err) {
      logger.warn({ err }, '[wiki-fts] FTS table corrupted, will recreate');
      needsRecreate = true;
    }
  }

  if (needsRecreate) {
    sqlite.exec('DROP TABLE IF EXISTS wiki_documents_fts');
    sqlite.exec(
      "CREATE VIRTUAL TABLE wiki_documents_fts USING fts5(search_text, document_id, project_id, tokenize='unicode61')"
    );
    ftsTable = { name: 'wiki_documents_fts' };
  }

  const emptyRows = await db
    .select({ id: wikiDocuments.id, contentMd: wikiDocuments.contentMd })
    .from(wikiDocuments)
    .where(eq(wikiDocuments.searchText, ''));

  if (emptyRows.length > 0) {
    logger.info({ count: emptyRows.length }, '[wiki-fts] backfilling search_text for documents');

    sqlite.exec('DROP TRIGGER IF EXISTS trg_wiki_documents_fts_au');
    sqlite.exec('DROP TRIGGER IF EXISTS trg_wiki_documents_fts_ai');

    try {
      const updateStmt = sqlite.prepare('UPDATE wiki_documents SET search_text = ? WHERE id = ?');
      for (const row of emptyRows) {
        const text = extractSearchText(row.contentMd);
        if (text) updateStmt.run(text, row.id);
      }
    } finally {
      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_wiki_documents_fts_ai AFTER INSERT ON wiki_documents
        WHEN new.search_text != '' BEGIN
          INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
          VALUES (new.search_text, new.id, new.project_id);
        END;
      `);
      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_wiki_documents_fts_au AFTER UPDATE OF search_text ON wiki_documents
        WHEN new.search_text != old.search_text BEGIN
          DELETE FROM wiki_documents_fts WHERE document_id = old.id;
          INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
          VALUES (new.search_text, new.id, new.project_id);
        END;
      `);
    }
  }

  const searchPopulated = (sqlite.prepare(
    "SELECT COUNT(*) AS n FROM wiki_documents WHERE search_text != ''"
  ).get() as { n: number }).n;

  if (searchPopulated > 0) {
    sqlite.exec('DELETE FROM wiki_documents_fts');
    sqlite.exec(`
      INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
      SELECT search_text, id, project_id
      FROM wiki_documents
      WHERE search_text != ''
    `);
    logger.info({ indexed: searchPopulated }, '[wiki-fts] FTS rebuild complete');
  } else {
    logger.warn('[wiki-fts] no documents have search_text — FTS table not rebuilt, preserving existing data');
  }

  return { indexed: searchPopulated };
}

export function updateDocumentSearchText(documentId: string, contentMd: string): void {
  const sqlite = getRawSqlite();
  const text = extractSearchText(contentMd);
  sqlite.prepare('UPDATE wiki_documents SET search_text = ? WHERE id = ?').run(text, documentId);
}
