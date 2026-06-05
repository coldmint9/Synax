// ---------------------------------------------------------------------------
// api/services/wiki/wiki-fts.ts — FTS5 全文搜索服务
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import { wikiBlocks } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type {
  Segment,
  ListItem,
  WikiBlockType,
} from './contracts.js';

// ── CJK character separation ────────────────────────────────────────────────
// unicode61 tokenizer treats continuous CJK as one giant token. To make every
// character independently searchable we insert spaces around CJK codepoints.
// English words and punctuation are left untouched.

const CJK_RANGES: Array<[number, number]> = [
  [0x4E00, 0x9FFF], // CJK Unified Ideographs
  [0x3400, 0x4DBF], // CJK Extension A
  [0xF900, 0xFAFF], // CJK Compatibility Ideographs
];

function isCJK(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Insert spaces around every CJK character so unicode61 treats each as a token. */
export function cjkSeparate(text: string): string {
  let result = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    result += isCJK(cp) ? ' ' + ch + ' ' : ch;
  }
  return result.replace(/\s+/g, ' ').trim();
}

// ── Text Extraction ─────────────────────────────────────────────────────────

function segmentsToText(segments: unknown): string {
  if (!Array.isArray(segments)) return '';
  return (segments as Segment[]).map(s => 'value' in s ? s.value : ('label' in s ? s.label : '')).join('');
}

function listItemsToText(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return (items as ListItem[]).map(item => {
    const text = segmentsToText(item.segments);
    const childText = item.children ? listItemsToText(item.children) : '';
    return childText ? `${text} ${childText}` : text;
  }).join(' ');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '');
}

/**
 * Extract plaintext from a wiki block's structured content, with CJK characters
 * space-separated so the unicode61 FTS tokenizer treats each as an independent
 * token (every CJK character is individually searchable).
 */
export function extractSearchText(
  blockType: WikiBlockType,
  contentFormat: string,
  content: unknown,
): string {
  if (!content) return '';

  let raw: string;
  if (contentFormat === 'markdown_fragment') {
    raw = typeof content === 'string' ? stripMarkdown(content) : '';
  } else if (contentFormat === 'structured_json') {
    const c = content as Record<string, unknown>;
    switch (blockType) {
      case 'heading':
        raw = typeof c.text === 'string' ? c.text : '';
        break;
      case 'prose':
        raw = segmentsToText(c.segments);
        break;
      case 'signature': {
        const tokens = Array.isArray(c.tokens) ? (c.tokens as Array<{ value: string }>) : [];
        raw = tokens.map(t => t.value).join('');
        break;
      }
      case 'callout': {
        const title = typeof c.title === 'string' ? c.title : '';
        const body = segmentsToText(c.body);
        raw = `${title} ${body}`.trim();
        break;
      }
      case 'list':
        raw = listItemsToText(c.items);
        break;
      case 'table': {
        const headers = Array.isArray(c.headers)
          ? (c.headers as Array<{ label: string }>).map(h => h.label).join(' ')
          : '';
        const rows = Array.isArray(c.rows)
          ? (c.rows as Array<Record<string, string | { type: string; value: string }>>)
              .flatMap(row => Object.values(row).map(v => typeof v === 'string' ? v : v.value))
              .join(' ')
          : '';
        raw = `${headers} ${rows}`.trim();
        break;
      }
      case 'diagram': {
        raw = typeof c.caption === 'string' ? c.caption : '';
        break;
      }
      default:
        raw = typeof content === 'string' ? content : JSON.stringify(content).slice(0, 500);
    }
  } else {
    raw = typeof content === 'string' ? content : '';
  }

  return cjkSeparate(raw);
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface WikiSearchResult {
  blockId: string;
  documentId: string;
  blockType: string;
  snippet: string;
  rank: number;
}

export interface WikiSearchOptions {
  projectId: string;
  query: string;
  limit?: number;
  documentId?: string;
}

/**
 * Full-text search across wiki blocks using FTS5 unicode61 tokenizer.
 * search_text is pre-processed with CJK character separation so every
 * CJK character is an independent token and English words stay as whole tokens.
 */
export function searchWikiBlocks(opts: WikiSearchOptions): WikiSearchResult[] {
  const { projectId, query, limit = 50, documentId } = opts;
  const sqlite = getRawSqlite();

  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  // CJK-separate the query the same way search_text is indexed, so "认证"
  // becomes "认 证" (AND of two CJK character tokens).
  const ftsQuery = cjkSeparate(trimmed);

  let sql: string;
  let params: unknown[];

  if (documentId) {
    sql = `
      SELECT
        b.id AS block_id,
        b.document_id,
        b.block_type,
        b.search_text,
        fts.rank
      FROM wiki_blocks_fts fts
      JOIN wiki_blocks b ON b.id = fts.block_id
      WHERE wiki_blocks_fts MATCH ?
        AND b.project_id = ?
        AND b.document_id = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [ftsQuery, projectId, documentId, limit];
  } else {
    sql = `
      SELECT
        b.id AS block_id,
        b.document_id,
        b.block_type,
        b.search_text,
        fts.rank
      FROM wiki_blocks_fts fts
      JOIN wiki_blocks b ON b.id = fts.block_id
      WHERE wiki_blocks_fts MATCH ?
        AND b.project_id = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params = [ftsQuery, projectId, limit];
  }

  let rows: Array<{ block_id: string; document_id: string; block_type: string; search_text: string; rank: number }>;
  try {
    rows = sqlite.prepare(sql).all(...params) as typeof rows;
  } catch (err) {
    // FTS table might not exist yet (first run before rebuild)
    logger.warn({ err, projectId, query: trimmed }, '[wiki-fts] search query failed');
    return [];
  }

  return rows.map(r => ({
    blockId: r.block_id,
    documentId: r.document_id,
    blockType: r.block_type,
    snippet: generateSnippet(r.search_text, trimmed),
    rank: r.rank,
  }));
}

function generateSnippet(text: string, query: string, contextChars = 80): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);
  if (idx === -1) return text.slice(0, contextChars * 2);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ── Index Rebuild ───────────────────────────────────────────────────────────

/**
 * Rebuild the FTS index for all wiki blocks.
 * Called on first startup after migration, or manually to reindex.
 */
/**
 * Rebuild the FTS index for all wiki blocks.
 * Called on startup — backfills search_text, recreates FTS table if tokenizer
 * changed or table is corrupted, and reindexes all blocks.
 */
export async function rebuildWikiFtsIndex(): Promise<{ indexed: number }> {
  const sqlite = getRawSqlite();
  const db = getDb();

  // Check if FTS table exists at all
  let ftsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_blocks_fts'")
    .get() as { name: string } | undefined;

  if (!ftsTable) {
    logger.info('[wiki-fts] FTS table does not exist yet, skipping rebuild');
    return { indexed: 0 };
  }

  // Detect and fix issues: corruption or wrong tokenizer (old trigram table)
  let needsRecreate = false;
  try {
    const createSql = (sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_blocks_fts'"
    ).get() as { sql: string }).sql;
    if (!createSql.includes("unicode61")) {
      logger.info('[wiki-fts] tokenizer changed — recreating FTS table as unicode61');
      needsRecreate = true;
    }
  } catch { /* table might be corrupted, will recreate below */ }

  if (!needsRecreate) {
    try {
      sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_blocks_fts').get();
    } catch (err) {
      logger.warn({ err }, '[wiki-fts] FTS table corrupted, will recreate');
      needsRecreate = true;
    }
  }

  if (needsRecreate) {
    sqlite.exec('DROP TABLE IF EXISTS wiki_blocks_fts');
    sqlite.exec(
      "CREATE VIRTUAL TABLE wiki_blocks_fts USING fts5(search_text, block_id, document_id, project_id, tokenize='unicode61')"
    );
    ftsTable = { name: 'wiki_blocks_fts' };
  }

  // Backfill search_text for blocks that don't have it yet
  const emptyRows = await db
    .select({ id: wikiBlocks.id, blockType: wikiBlocks.blockType, contentFormat: wikiBlocks.contentFormat, contentJson: wikiBlocks.contentJson })
    .from(wikiBlocks)
    .where(eq(wikiBlocks.searchText, ''));

  if (emptyRows.length > 0) {
    logger.info({ count: emptyRows.length }, '[wiki-fts] backfilling search_text for blocks');

    const updateStmt = sqlite.prepare('UPDATE wiki_blocks SET search_text = ? WHERE id = ?');

    const txn = sqlite.transaction(() => {
      for (const row of emptyRows) {
        const content = JSON.parse(row.contentJson);
        const text = extractSearchText(
          row.blockType as WikiBlockType,
          row.contentFormat,
          content,
        );
        if (text) {
          updateStmt.run(text, row.id);
        }
      }
    });
    txn();
  }

  // Rebuild FTS from all blocks that have search_text
  sqlite.exec('DELETE FROM wiki_blocks_fts');
  sqlite.exec(`
    INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
    SELECT search_text, id, document_id, project_id
    FROM wiki_blocks
    WHERE search_text != ''
  `);

  const indexed = (sqlite.prepare("SELECT COUNT(*) AS n FROM wiki_blocks WHERE search_text != ''").get() as { n: number }).n;
  logger.info({ indexed }, '[wiki-fts] FTS rebuild complete');
  return { indexed };
}

/**
 * Update search_text for a single block. Called after block content changes.
 */
export function updateBlockSearchText(
  blockId: string,
  blockType: WikiBlockType,
  contentFormat: string,
  content: unknown,
): void {
  const sqlite = getRawSqlite();
  const text = extractSearchText(blockType, contentFormat, content);
  sqlite.prepare('UPDATE wiki_blocks SET search_text = ? WHERE id = ?').run(text, blockId);
}
