// ---------------------------------------------------------------------------
// api/services/context/compression-service.ts
//
// 上下文压缩策略：
//   summarizeEntries   -> 本地规则化摘要，避免依赖外部 analyzer 服务
//   buildSlidingWindow -> 保留最近 N 条，并把旧条目摘要写入 snapshot
//   maybeCompress      -> 超出阈值时自动压缩
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js'
import { logger } from '../../lib/logger.js'
import { contextService } from './context-service.js'
import { sessionManager } from './session-manager.js'
import type { CompressionResult, ContextEntry } from '../contracts/context.js'

const DEFAULT_RECENT_WINDOW = 20

export class CompressionService {
  private db = getRawSqlite()

  async summarizeEntries(entries: ContextEntry[]): Promise<string> {
    if (entries.length === 0) return ''
    logger.debug('context: summarizeEntries uses local rule fallback')
    const first = entries[0]
    const last = entries[entries.length - 1]
    const hint = `${entries.length} entries between seq ${first.sequence} and ${last.sequence}.`
    const preview = entries
      .slice(0, 5)
      .map((e) => `- [${e.role}] ${e.content.slice(0, 120)}`)
      .join('\n')
    return `[summary fallback] ${hint}\n${preview}`
  }

  /**
   * \u4fdd\u7559\u6700\u8fd1 recentN \u6761\uff0c\u5176\u4f59\u6458\u8981\u4e3a\u4e00\u6761 snapshot\u3002\u4e0d\u5220\u9664\u6761\u76ee\u3002
   */
  async buildSlidingWindow(
    sessionId: string,
    recentN = DEFAULT_RECENT_WINDOW,
  ): Promise<CompressionResult | null> {
    const session = contextService.getSession(sessionId)
    if (!session) return null
    const all = contextService.getEntries(sessionId, { limit: 1000 }).items
    if (all.length <= recentN) return null
    const older = all.slice(0, all.length - recentN)
    const remaining = all.slice(-recentN)
    const summary = await this.summarizeEntries(older)
    const snapshot = contextService.createSnapshot(sessionId, {
      label: 'auto-compress',
      fromSequence: older[0]?.sequence ?? 0,
      toSequence: older[older.length - 1]?.sequence ?? 0,
      compressedContent: summary,
      createdBy: 'compression-service',
    })
    // \u66f4\u65b0\u4f1a\u8bdd summary\uff0c\u4fbf\u4e8e\u5217\u8868\u9875\u5c55\u793a
    contextService.updateSession(sessionId, { summary })
    return {
      sessionId,
      summary,
      removedEntryCount: older.length,
      remainingEntryCount: remaining.length,
      snapshotId: snapshot.id,
    }
  }

  /**
   * \u8d85\u9608\u624d\u538b\u7f29\u3002\u8fd4\u56de null \u8868\u793a\u672a\u89e6\u53d1\u3002
   */
  async maybeCompress(
    sessionId: string,
    tokenThreshold = 24_000,
  ): Promise<CompressionResult | null> {
    const tokens = sessionManager.estimateSessionTokens(sessionId)
    if (tokens < tokenThreshold) return null
    return this.buildSlidingWindow(sessionId)
  }
}

export const compressionService = new CompressionService()
