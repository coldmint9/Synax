// ---------------------------------------------------------------------------
// api/services/context/memory-manager.ts
//
// \u957f\u671f\u9879\u76ee\u8bb0\u5fc6\u63d0\u53d6\u4e0e\u68c0\u7d22\u3002
//
// \u8bbe\u8ba1\u8981\u70b9\uff1a
//   - 提取逻辑现在由本地 analyzer-service 兜底，离线时直接走规则匹配。
//   - \u68c0\u7d22\u8d70 FTS5\uff08\u5f53\u524d\u4f7f\u7528 searchService \u7684 searchMemories\uff09+ accessCount \u52a0\u6743\u3002
//   - LRU \u6dd8\u6c70\u57fa\u4e8e access_count ASC, updated_at ASC\uff0c\u5f52\u6863\u800c\u975e\u5220\u9664\u3002
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js'
import { CONTEXT_MEMORY_MAX_PER_PROJECT } from '../../lib/env.js'
import { logger } from '../../lib/logger.js'
import { contextService } from './context-service.js'
import { searchService } from './search-service.js'
import type {
  ContextEntry,
  MemoryType,
  NewMemory,
  ProjectMemory,
} from '../contracts/context.js'

interface LlmExtracted {
  type: MemoryType
  title: string
  content: string
  tags?: string[]
  confidence?: number
}

const RULE_PATTERNS: Array<{ type: MemoryType; regex: RegExp }> = [
  { type: 'decision', regex: /\b(we decided|we chose|let's use|will use|agreed on)\b/i },
  { type: 'convention', regex: /\b(always|must|should always|never|convention:|style:)\b/i },
  { type: 'pattern', regex: /\b(pattern:|refactor|use the .* pattern)\b/i },
  { type: 'preference', regex: /\b(prefer|preference|rather)\b/i },
  { type: 'risk', regex: /\b(risk|beware|caution|warning|broken)\b/i },
  { type: 'insight', regex: /\b(insight|learned|turns out|actually)\b/i },
]

export class MemoryManager {
  private db = getRawSqlite()

  /**
   * \u4ece\u6307\u5b9a\u4f1a\u8bdd\u63d0\u53d6\u53ef\u590d\u7528\u77e5\u8bc6\u3002\u8fd4\u56de\u5df2\u5199\u5165\u7684\u8bb0\u5fc6\u5217\u8868\u3002
   */
  async extractMemories(sessionId: string): Promise<ProjectMemory[]> {
    const session = contextService.getSession(sessionId)
    if (!session) return []
    const entries = contextService.getEntries(sessionId, { limit: 500 }).items
    const candidates = await this.inferCandidates(entries).catch(() => [])
    const fallback = candidates.length === 0 ? this.ruleBasedExtract(entries) : candidates

    const outcomes: ProjectMemory[] = []
    for (const cand of fallback) {
      const mem = this.upsertMemory(session.projectId, {
        memoryType: cand.type,
        title: cand.title.slice(0, 200),
        content: cand.content.slice(0, 20_000),
        sourceSessionId: sessionId,
        tags: cand.tags ?? [],
        confidence: cand.confidence ?? 0.6,
      })
      outcomes.push(mem)
    }
    this.evictMemories(session.projectId)
    return outcomes
  }

  /**
   * \u83b7\u53d6\u4e0e\u5f53\u524d\u4e0a\u4e0b\u6587\u76f8\u5173\u7684\u8bb0\u5fc6 top-K\uff0c\u7528\u4e8e analyzer / context \u6ce8\u5165\u3002
   */
  getRelevantMemories(
    projectId: string,
    currentContext: string,
    topK = 5,
  ): ProjectMemory[] {
    const hits = searchService.searchMemories(projectId, currentContext, {
      limit: Math.max(topK * 2, 10),
    })
    const byId = new Map<string, number>()
    for (const h of hits) byId.set(h.id, h.score)
    if (byId.size === 0) return []
    const ids = [...byId.keys()]
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM project_memories
         WHERE id IN (${placeholders}) AND status = 'active'`,
      )
      .all(...ids) as Array<Record<string, unknown>>
    const list = rows
      .map((r) => contextService.getMemory(r.id as string))
      .filter((x): x is ProjectMemory => !!x)
      .sort((a, b) => (byId.get(b.id) ?? 0) - (byId.get(a.id) ?? 0))
      .slice(0, topK)
    for (const m of list) contextService.touchMemory(m.id)
    return list
  }

  /**
   * \u5199\u5165\u8bb0\u5fc6\u3002\u540c title \u5408\u5e76 tags\u3001\u66f4\u65b0 confidence\uff1b\u5426\u5219\u65b0\u5efa\u3002
   */
  upsertMemory(projectId: string, memory: NewMemory): ProjectMemory {
    const existing = this.db
      .prepare(
        `SELECT id, tags, confidence FROM project_memories
         WHERE project_id = ? AND title = ? AND memory_type = ? AND status = 'active'`,
      )
      .get(projectId, memory.title, memory.memoryType) as
      | { id: string; tags: string; confidence: number }
      | undefined
    if (existing) {
      const oldTags = safeParseArray(existing.tags)
      const merged = Array.from(new Set([...(oldTags ?? []), ...(memory.tags ?? [])]))
      return contextService.updateMemory(existing.id, {
        content: memory.content,
        tags: merged,
        confidence: Math.max(existing.confidence, memory.confidence ?? 0),
      })
    }
    return contextService.createMemory(projectId, memory)
  }

  /**
   * \u8d85\u9650\u65f6\u6309 access_count ASC, updated_at ASC \u5f52\u6863\uff08\u975e\u6bc1\u6027\u5220\u9664\uff09\u3002
   */
  evictMemories(projectId: string, maxCount = CONTEXT_MEMORY_MAX_PER_PROJECT): number {
    const count = (this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM project_memories WHERE project_id = ? AND status = 'active'`,
      )
      .get(projectId) as { c: number }).c
    if (count <= maxCount) return 0
    const excess = count - maxCount
    const rows = this.db
      .prepare(
        `SELECT id FROM project_memories
         WHERE project_id = ? AND status = 'active'
         ORDER BY access_count ASC, updated_at ASC
         LIMIT ?`,
      )
      .all(projectId, excess) as Array<{ id: string }>
    let archived = 0
    for (const r of rows) {
      contextService.updateMemory(r.id, { status: 'archived' })
      archived++
    }
    if (archived > 0) logger.info({ projectId, archived }, 'context: memory LRU eviction')
    return archived
  }

  // --------------------------- \u63a8\u5bfc\u5b9e\u73b0 ---------------------------

  private async inferCandidates(entries: ContextEntry[]): Promise<LlmExtracted[]> {
    if (entries.length === 0) return []
    logger.debug('context: local memory extraction is rule-based')
    return this.ruleBasedExtract(entries)
  }

  private ruleBasedExtract(entries: ContextEntry[]): LlmExtracted[] {
    const out: LlmExtracted[] = []
    for (const e of entries) {
      if (e.role !== 'user' && e.role !== 'assistant') continue
      const firstLine = e.content.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      if (firstLine.length < 12) continue
      for (const r of RULE_PATTERNS) {
        if (r.regex.test(e.content)) {
          out.push({
            type: r.type,
            title: firstLine.slice(0, 120),
            content: e.content.slice(0, 2000),
            tags: [r.type],
            confidence: 0.5,
          })
          break
        }
      }
    }
    return out
  }
}

function safeParseArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String) : null
  } catch {
    return null
  }
}

export const memoryManager = new MemoryManager()
