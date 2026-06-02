// ---------------------------------------------------------------------------
// api/services/context/session-manager.ts
//
// 会话生命周期治理：
//   - createOrResumeSession：按 (projectId, userId, sourceAgent) 复用活跃会话
//   - estimateSessionTokens：返回会话当前 token 总量（读自 DB，避免漂移）
//   - cleanupExpiredSessions：TTL 扫描并标记为 expired（定时任务调用）
//   - checkTokenWarning：命中阈值时发射 session_token_warning 同步事件
// ---------------------------------------------------------------------------

import { getRawSqlite } from '../../db/index.js';
import {
  CONTEXT_SESSION_TTL_HOURS,
  CONTEXT_TOKEN_WARNING_THRESHOLD,
} from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { contextService } from './context-service.js';
import { syncBus } from './sync-bus.js';
import { SyncEventType } from '../contracts/context.js';
import type { ContextSession } from '../contracts/context.js';

export class SessionManager {
  private db = getRawSqlite();

  /**
   * 查找同项目/同用户/同来源的活跃会话；如存在且尚未过期则复用，否则新建。
   * 复用条件遵循"相同上下文主体 → 相同会话"的直觉。
   */
  createOrResumeSession(
    projectId: string,
    userId: string,
    sourceAgent?: string,
  ): ContextSession {
    const row = this.db
      .prepare(
        `SELECT id FROM context_sessions
         WHERE project_id = ? AND user_id = ? AND status = 'active'
           AND COALESCE(source_agent, '') = COALESCE(?, '')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(projectId, userId, sourceAgent ?? null) as { id: string } | undefined;

    if (row) {
      const existing = contextService.getSession(row.id);
      if (existing && !this.isExpired(existing)) return existing;
    }

    return contextService.createSession(projectId, userId, {
      sourceAgent,
      ttlHours: CONTEXT_SESSION_TTL_HOURS,
    });
  }

  estimateSessionTokens(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT token_count FROM context_sessions WHERE id = ?`)
      .get(sessionId) as { token_count: number } | undefined;
    return row?.token_count ?? 0;
  }

  /**
   * 标记所有已过期（expires_at < now）的活跃会话为 expired。
   * @returns 变更的会话数
   */
  cleanupExpiredSessions(): number {
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE context_sessions
         SET status = 'expired', updated_at = ?
         WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .run(ts, ts);
    if (info.changes > 0) {
      logger.info({ changes: info.changes }, 'context: expired sessions cleaned up');
    }
    return info.changes as number;
  }

  /** 若会话 token 超出阈值，发出 token 预警事件。 */
  checkTokenWarning(sessionId: string): void {
    const s = contextService.getSession(sessionId);
    if (!s) return;
    if (s.tokenCount >= CONTEXT_TOKEN_WARNING_THRESHOLD) {
      syncBus.emit({
        type: SyncEventType.SessionTokenWarning,
        projectId: s.projectId,
        sessionId: s.id,
        payload: {
          tokenCount: s.tokenCount,
          threshold: CONTEXT_TOKEN_WARNING_THRESHOLD,
        },
        timestamp: Date.now(),
      });
    }
  }

  getSessionTTL(): number {
    return CONTEXT_SESSION_TTL_HOURS;
  }

  private isExpired(s: ContextSession): boolean {
    if (!s.expiresAt) return false;
    return new Date(s.expiresAt).getTime() < Date.now();
  }
}

export const sessionManager = new SessionManager();

// 后台定时清理：每 30 分钟扫描一次过期会话。
// 仅在服务器进程内启动，测试环境可通过 DISABLE_CONTEXT_CLEANUP=1 关闭。
if (process.env.DISABLE_CONTEXT_CLEANUP !== '1') {
  const timer = setInterval(
    () => {
      try {
        sessionManager.cleanupExpiredSessions();
      } catch (err) {
        logger.warn({ err }, 'context: cleanupExpiredSessions failed');
      }
    },
    30 * 60 * 1000,
  );
  // 防止阻塞进程退出
  timer.unref?.();
}
