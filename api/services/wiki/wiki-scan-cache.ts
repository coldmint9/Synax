// ---------------------------------------------------------------------------
// api/services/wiki/wiki-scan-cache.ts
//
// Git-state-based scan result cache — 仅当 git 分支版本（branch + HEAD commit +
// working tree hash）一致时命中，避免每次 wiki 生成都重新跑一遍 tree-sitter 分析
// ---------------------------------------------------------------------------

import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiScanGitCache } from '../../db/schema.js';
import { runCodeMapScan } from '../analyzer/scan.js';
import type { WikiGitState } from './wiki-snapshot-service.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { logger } from '../../lib/logger.js';

/** Stable hash used when git is unavailable — must not be random per request. */
export const NO_GIT_WORKING_TREE_HASH = '0000000000000000';

export function fallbackGitState(): WikiGitState {
  return {
    branch: 'unknown',
    headCommitSha: '0000000000000000000000000000000000000000',
    workingTreeHash: NO_GIT_WORKING_TREE_HASH,
    dirty: false,
  };
}

export type ScanCacheHitKind = 'git-exact' | 'git-commit' | null;

export interface AcquireScanResult {
  scan: CodeMapScanResult;
  fromCache: boolean;
  cacheKind: ScanCacheHitKind;
}

function parseCachedRow(row: { resultJson: string }): CodeMapScanResult {
  return JSON.parse(row.resultJson) as CodeMapScanResult;
}

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

    const result = parseCachedRow(rows[0]);

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
 * When the working tree is clean, any cached scan for the same commit is valid
 * even if the exact workingTreeHash key differs (e.g. legacy entries).
 */
export async function loadCachedScanByCommit(
  projectId: string,
  gitState: Pick<WikiGitState, 'branch' | 'headCommitSha'>,
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
        ),
      )
      .orderBy(desc(wikiScanGitCache.updatedAt))
      .limit(1);

    if (!rows[0]) return null;

    const result = parseCachedRow(rows[0]);
    logger.info({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha.slice(0, 8),
      scanId: result.scanId,
    }, 'wiki-scan-cache: HIT (commit-level) — reusing cached scan result');
    return result;
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki-scan-cache: failed to load commit-level cache');
    return null;
  }
}

/**
 * Tiered cache lookup: exact git state → same commit (clean tree only) → miss.
 */
export async function loadCachedScanWithFallback(
  projectId: string,
  gitState: WikiGitState,
): Promise<{ scan: CodeMapScanResult; kind: ScanCacheHitKind } | null> {
  logger.info({
    projectId,
    branch: gitState.branch,
    headCommitSha: gitState.headCommitSha.slice(0, 8),
    workingTreeHash: gitState.workingTreeHash,
    dirty: gitState.dirty,
  }, 'wiki-scan-cache: checking cache');

  const exact = await loadCachedScanByGitState(projectId, gitState);
  if (exact) return { scan: exact, kind: 'git-exact' };

  if (!gitState.dirty) {
    const byCommit = await loadCachedScanByCommit(projectId, gitState);
    if (byCommit) return { scan: byCommit, kind: 'git-commit' };
  }

  logger.info({ projectId }, 'wiki-scan-cache: MISS — will run code map scan');
  return null;
}

/**
 * Resolve a CodeMapScanResult: check cache first, scan only on miss, persist new scans.
 */
export async function acquireCodeMapScan(input: {
  projectId: string;
  workDir: string;
  gitState: WikiGitState;
}): Promise<AcquireScanResult> {
  const { projectId, workDir, gitState } = input;
  const cached = await loadCachedScanWithFallback(projectId, gitState);
  if (cached) {
    return { scan: cached.scan, fromCache: true, cacheKind: cached.kind };
  }

  logger.info({ projectId, workDir }, 'wiki-scan-cache: running code map scan');
  const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });
  await persistScanCacheByGitState(projectId, scan, gitState);
  return { scan, fromCache: false, cacheKind: null };
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
