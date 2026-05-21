// ---------------------------------------------------------------------------
// api/services/context/search-service.ts
//
// 基于 SQLite FTS5 的全文搜索。
//
// 范围（scope）：
//   entries  -> 仅搜索 context_entries（FTS5 虚拟表）
//   memories -> 仅搜索 project_memories（LIKE 扫描，通常量级较小）
//   all      -> 并集，统一返回
//
// 评分策略：
//   - entries：bm25() 越小越相关，这里转换为 1 / (1 + bm25)
//   - memories：按 access_count + 精确匹配加权
//
// 查询串处理：用户原始输入先做宽松转义，避免 FTS5 语法异常导致报错。
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js';
import type {
  EntryRole,
  MemoryType,
  SearchFilter,
  SearchHit,
  Suggestion,
} from '../contracts/context.js';
import { contextService } from './context-service.js';

const DEFAULT_LIMIT = 20;

/**
 * 将用户输入转换为 FTS5 的 MATCH 安全表达式。
 * 策略：
 *   - 按空白分词
 *   - 剥除 FTS5 特殊字符（" ( ) * : AND OR NOT NEAR）
 *   - 每个 token 加 "*" 作为前缀匹配
 *   - 用 AND 连接
 */
function sanitizeFtsQuery(q: string): string {
  const tokens = q
    .split(/\s+/g)
    .map((t) => t.replace(/["()*:]/g, '').replace(/[-]/g, ' ').trim())
    .filter(Boolean)
    .map((t) => (t.length <= 2 ? `"${t}"` : `${t}*`));
  return tokens.length ? tokens.join(' AND ') : '';
}

export class SearchService {
  private db = getRawSqlite();

  searchEntries(
    projectId: string,
    query: string,
    filter: SearchFilter = {},
  ): SearchHit[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, 100);
    // 注意：context_fts 为 external content 模式(content='context_entries')，
    // UNINDEXED 列 entry_id 在 content 表无同名列(context_entries 主键为 id)，
    // 直接 select/where 会触发 "no such column: T.entry_id"。
    // 所有元数据过滤改走 context_entries 自身列，JOIN 用 rowid。
    const where: string[] = ['context_fts MATCH ?', 'e.project_id = ?'];
    const params: unknown[] = [ftsQuery, projectId];
    if (filter.sessionId) {
      where.push('e.session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.role) {
      where.push('e.role = ?');
      params.push(filter.role);
    }

    const sql = `
      SELECT
        e.id            AS id,
        e.project_id    AS project_id,
        e.session_id    AS session_id,
        e.role          AS role,
        e.created_at    AS created_at,
        snippet(context_fts, 0, '[', ']', '…', 16) AS snippet,
        bm25(context_fts) AS score
      FROM context_fts f
      JOIN context_entries e ON e.rowid = f.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY score ASC
      LIMIT ?`;

    try {
      const rows = this.db.prepare(sql).all(...params, limit) as Array<{
        id: string;
        project_id: string;
        session_id: string;
        role: string;
        created_at: string;
        snippet: string;
        score: number;
      }>;
      return rows.map((r) => ({
        kind: 'entry' as const,
        id: r.id,
        projectId: r.project_id,
        sessionId: r.session_id,
        snippet: r.snippet,
        score: 1 / (1 + Math.max(0, r.score)),
        createdAt: r.created_at,
      }));
    } catch {
      // FTS 语法异常时退化为空结果
      return [];
    }
  }

  searchMemories(
    projectId: string,
    query: string,
    filter: SearchFilter = {},
  ): SearchHit[] {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, 100);
    const like = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const where: string[] = [
      'project_id = ?',
      "status = 'active'",
      '(title LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\')',
    ];
    const params: unknown[] = [projectId, like, like];
    if (filter.memoryType) {
      where.push('memory_type = ?');
      params.push(filter.memoryType);
    }
    const rows = this.db
      .prepare(
        `SELECT id, project_id, title, content, access_count, created_at, memory_type
         FROM project_memories
         WHERE ${where.join(' AND ')}
         ORDER BY access_count DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: string;
      project_id: string;
      title: string;
      content: string;
      access_count: number;
      created_at: string;
      memory_type: MemoryType;
    }>;

    const q = query.toLowerCase();
    return rows.map((r) => {
      const hay = `${r.title}\n${r.content}`.toLowerCase();
      const exact = hay.includes(q) ? 1 : 0;
      return {
        kind: 'memory' as const,
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        snippet: this.extractSnippet(r.content, q),
        score: exact + Math.min(r.access_count, 20) / 20,
        createdAt: r.created_at,
      };
    });
  }

  searchAll(projectId: string, query: string, filter: SearchFilter = {}): SearchHit[] {
    const entries = this.searchEntries(projectId, query, filter);
    const memories = this.searchMemories(projectId, query, filter);
    return [...entries, ...memories].sort((a, b) => b.score - a.score).slice(0, filter.limit ?? 30);
  }

  /** 基于历史条目的意图自动补全（取近期 user role 条目，匹配前缀）。 */
  suggest(projectId: string, partialIntent: string, limit = 5): Suggestion[] {
    const q = partialIntent.trim();
    if (q.length < 2) return [];
    const like = `${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const rows = this.db
      .prepare(
        `SELECT id, content, created_at
         FROM context_entries
         WHERE project_id = ? AND role = 'user' AND content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, like, limit * 2) as Array<{
      id: string;
      content: string;
      created_at: string;
    }>;
    const seen = new Set<string>();
    const list: Suggestion[] = [];
    for (const r of rows) {
      const text = r.content.split('\n')[0]?.slice(0, 160).trim() ?? '';
      if (!text || seen.has(text)) continue;
      seen.add(text);
      list.push({ text, source: 'entry', refId: r.id, score: 1 });
      if (list.length >= limit) break;
    }
    return list;
  }

  /** 触碰命中的记忆访问计数（供路由层在命中后调用）。 */
  touchHits(hits: SearchHit[]): void {
    for (const h of hits) {
      if (h.kind === 'memory') contextService.touchMemory(h.id);
    }
  }

  private extractSnippet(content: string, q: string): string {
    const idx = content.toLowerCase().indexOf(q);
    if (idx < 0) return content.slice(0, 160);
    const start = Math.max(0, idx - 40);
    const end = Math.min(content.length, idx + q.length + 80);
    return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
  }
}

export const searchService = new SearchService();
// 仅为 lint：类型引用避免被 tree-shake
export type { EntryRole };
