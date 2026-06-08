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
  return (items as (ListItem | string)[]).map(item => {
    // Handle string items (simplified list format: ["item1", "item2"])
    if (typeof item === 'string') return item;
    // Handle object items with segments and optional children
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
 *
 * Handles multiple content shapes robustly:
 * - markdown_fragment with string content (standard)
 * - markdown_fragment with object content (legacy mislabel — fall through to structured extraction)
 * - structured_json with all expected block type shapes
 * - Simplified prose ({ text: "..." } vs { segments: [...] })
 * - Simplified list ({ items: ["str1", "str2"] } vs { items: [{ segments: [...] }] })
 * - diagram_json with caption or bare diagram code
 */
export function extractSearchText(
  blockType: WikiBlockType,
  contentFormat: string,
  content: unknown,
): string {
  if (!content) return '';

  let raw: string;

  // Determine the effective format — some blocks are labeled 'markdown_fragment'
  // but actually contain a structured JSON object (legacy generator output).
  const isStructuredObject = typeof content === 'object' && content !== null;
  const effectiveFormat = contentFormat === 'markdown_fragment' && isStructuredObject
    ? 'structured_json'
    : contentFormat;

  if (effectiveFormat === 'markdown_fragment') {
    raw = typeof content === 'string' ? stripMarkdown(content) : '';
  } else if (effectiveFormat === 'structured_json' || effectiveFormat === 'diagram_json') {
    const c = content as Record<string, unknown>;
    switch (blockType) {
      case 'heading':
        raw = typeof c.text === 'string' ? c.text : '';
        break;
      case 'prose': {
        // Handle both { segments: [...] } and { text: "..." } shapes
        const proseSegments = segmentsToText(c.segments);
        if (proseSegments) {
          raw = proseSegments;
        } else if (typeof c.text === 'string') {
          raw = c.text;
        } else {
          raw = '';
        }
        break;
      }
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
          : Array.isArray(c.headers)
            ? (c.headers as string[]).join(' ')
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
        // Prefer caption, fall back to diagramType + code description
        if (typeof c.caption === 'string' && c.caption.trim()) {
          raw = c.caption;
        } else if (typeof c.code === 'string') {
          // Extract any readable text from diagram code (e.g. node labels in mermaid)
          // Extract readable text from diagram code: keep node labels inside brackets
          // but strip the mermaid keywords, arrows, and other syntax characters.
          const codeText = c.code
            .replace(/\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline)\b/gi, ' ')
            .replace(/\b(TD|LR|RL|BT|TB)\b/gi, ' ')
            .replace(/[-=]{2,}>?/g, ' ')   // arrows: --> ----> ==> etc.
            .replace(/==?/g, ' ')           // thick arrows
            .replace(/-\.-?x?/g, ' ')       // dotted arrows
            .replace(/[\[\]{}()|;,@:<>]+/g, ' ')  // syntax delimiters
            .replace(/\|/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          raw = codeText || '';
        } else if (typeof c.diagramType === 'string') {
          raw = c.diagramType;
        } else {
          raw = '';
        }
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

  // Verify FTS table is available before attempting MATCH
  const ftsExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_blocks_fts'")
    .get() as { name: string } | undefined;

  if (!ftsExists) {
    logger.warn({ projectId, query: trimmed }, '[wiki-fts] FTS table missing — index may not have been built yet');
    return [];
  }

  // Check if FTS table has any content at all
  const ftsCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_blocks_fts').get() as { n: number }).n;
  if (ftsCount === 0) {
    logger.warn({ projectId, query: trimmed }, '[wiki-fts] FTS table exists but is empty — rebuild may have failed');
    return [];
  }

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
    logger.warn({ err, projectId, query: trimmed, ftsQuery }, '[wiki-fts] search MATCH query failed');
    return [];
  }

  if (rows.length === 0) {
    logger.warn({ projectId, query: trimmed, ftsQuery, ftsCount }, '[wiki-fts] MATCH returned no results');
  }

  return rows.map(r => ({
    blockId: r.block_id,
    documentId: r.document_id,
    blockType: r.block_type,
    snippet: generateSnippet(r.search_text, trimmed),
    rank: r.rank,
  }));
}

/**
 * Generate a snippet around the first match of query in text.
 * Handles CJK-separated text by searching for both the original query
 * and the CJK-separated version.
 */
function generateSnippet(text: string, query: string, contextChars = 80): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const ftsQueryLower = cjkSeparate(query).toLowerCase();

  // Try the CJK-separated query first (to match CJK queries against
  // CJK-separated search_text), then fall back to the raw query.
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

    // Drop triggers temporarily so the backfill doesn't fire per-row FTS sync
    // (the full rebuild happens right after). This also sidesteps a libsql
    // compatibility issue where FTS5 trigger operations inside
    // exec('BEGIN')/exec('COMMIT') transactions throw "SQL logic error".
    sqlite.exec('DROP TRIGGER IF EXISTS trg_wiki_blocks_fts_au');
    sqlite.exec('DROP TRIGGER IF EXISTS trg_wiki_blocks_fts_ai');

    try {
      const updateStmt = sqlite.prepare('UPDATE wiki_blocks SET search_text = ? WHERE id = ?');
      for (const row of emptyRows) {
        try {
          const content = JSON.parse(row.contentJson);
          const text = extractSearchText(
            row.blockType as WikiBlockType,
            row.contentFormat,
            content,
          );
          if (text) {
            updateStmt.run(text, row.id);
          }
        } catch (err) {
          logger.warn({ err, blockId: row.id }, '[wiki-fts] failed to backfill block, skipping');
        }
      }
    } finally {
      // Recreate the triggers so incremental FTS sync works after rebuild
      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_wiki_blocks_fts_ai AFTER INSERT ON wiki_blocks
        WHEN new.search_text != '' BEGIN
          INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
          VALUES (new.search_text, new.id, new.document_id, new.project_id);
        END;
      `);
      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_wiki_blocks_fts_au AFTER UPDATE OF search_text ON wiki_blocks
        WHEN new.search_text != old.search_text BEGIN
          DELETE FROM wiki_blocks_fts WHERE block_id = old.id;
          INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
          VALUES (new.search_text, new.id, new.document_id, new.project_id);
        END;
      `);
    }
  }

  // Rebuild FTS from all blocks that have search_text.
  // Only clear the FTS table if there are blocks to reindex — otherwise
  // preserve whatever data already exists in the FTS table.
  const searchPopulated = (sqlite.prepare(
    "SELECT COUNT(*) AS n FROM wiki_blocks WHERE search_text != ''"
  ).get() as { n: number }).n;

  if (searchPopulated > 0) {
    sqlite.exec('DELETE FROM wiki_blocks_fts');
    sqlite.exec(`
      INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
      SELECT search_text, id, document_id, project_id
      FROM wiki_blocks
      WHERE search_text != ''
    `);
    logger.info({ indexed: searchPopulated }, '[wiki-fts] FTS rebuild complete');
  } else {
    logger.warn('[wiki-fts] no blocks have search_text — FTS table not rebuilt, preserving existing data');
  }

  return { indexed: searchPopulated };
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
