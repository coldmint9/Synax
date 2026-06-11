// ---------------------------------------------------------------------------
// api/services/wiki/wiki-scan-cache.ts
//
// Git-state-based scan result cache — 仅当 git 分支版本（branch + HEAD commit +
// working tree hash）一致时命中，避免每次 wiki 生成都重新跑一遍 tree-sitter 分析
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiScanGitCache } from '../../db/schema.js';
import type { WikiGitState } from './wiki-snapshot-service.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { logger } from '../../lib/logger.js';

/**
 * 根据 git state 加载缓存的扫描结果。
 * 命中 → 返回完整 CodeMapScanResult（跳过 runCodeMapScan）
 * 未命中 → 返回 null
 */
export async function loadCachedScanByGitState(
  projectId: string,
  gitState: WikiGitState,
): Promise<CodeMapScanResult | null> {
  try {
    const db = getDb();
    const rows = await db.select()
      .from(wikiScanGitCache)
      .where(
        and(
          eq(wikiScanGitCache.projectId, projectId),
          eq(wikiScanGitCache.branch, gitState.branch),
          eq(wikiScanGitCache.headCommitSha, gitState.headCommitSha),
          eq(wikiScanGitCache.workingTreeHash, gitState.workingTreeHash),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;

    const row = rows[0];
    const result: CodeMapScanResult = JSON.parse(row.resultJson);

    logger.info({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha.slice(0, 8),
      scanId: result.scanId,
    }, 'wiki-scan-cache: HIT — reusing cached scan result');

    return result;
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki-scan-cache: failed to load cached scan');
    return null;
  }
}

/**
 * 将扫描结果按 git state 持久化。
 * 使用复合主键 upsert，同一 git state 只会存一份。
 */
export async function persistScanCacheByGitState(
  projectId: string,
  scan: CodeMapScanResult,
  gitState: WikiGitState,
): Promise<void> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(scan);

    await db.insert(wikiScanGitCache).values({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha,
      workingTreeHash: gitState.workingTreeHash,
      scanId: scan.scanId,
      resultJson,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [
        wikiScanGitCache.projectId,
        wikiScanGitCache.branch,
        wikiScanGitCache.headCommitSha,
        wikiScanGitCache.workingTreeHash,
      ],
      set: { scanId: scan.scanId, resultJson, updatedAt: now },
    });

    logger.info({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha.slice(0, 8),
      scanId: scan.scanId,
    }, 'wiki-scan-cache: persisted scan result');
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki-scan-cache: failed to persist scan result');
  }
}
