// ---------------------------------------------------------------------------
// api/services/wiki/wiki-refresh-service.ts
//
// Wiki refresh：增量索引 → hash-diff stale 检测 → 按文档分组 → LLM 生成 document drafts
// ---------------------------------------------------------------------------

function refreshMsg(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    title: 'Wiki Refresh',
    started: 'Document refresh check started',
    scanning: 'Scanning code index…',
    detecting: 'Detecting stale documents…',
    drafting: (count: number) => `Generating drafts for ${count} documents…`,
    complete: (docs: number, drafts: number) => `${docs} documents affected, ${drafts} drafts generated`,
    completeTitle: 'Wiki Refresh Complete',
    failed: 'Wiki Refresh Failed',
  } : {
    title: 'Wiki 刷新',
    started: '文档刷新检查已启动',
    scanning: '正在扫描代码索引…',
    detecting: '正在检测过期文档…',
    drafting: (count: number) => `正在为 ${count} 个文档生成草稿…`,
    complete: (docs: number, drafts: number) => `${docs} 个文档受影响，生成 ${drafts} 个草稿`,
    completeTitle: 'Wiki 刷新完成',
    failed: 'Wiki 刷新失败',
  };
}

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiRefreshTasks, wikiRefreshDrafts, wikiScanCache } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import { runCodeMapScan, compareScans, type ScanDiff } from '../analyzer/scan.js';
import { resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { createRefreshTools } from './wiki-refresh-tools.js';
import { ensureRefreshProfileRegistered } from './wiki-refresh-profile.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { publishLatestWikiSnapshot, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import { readGitState } from './wiki-snapshot-service.js';
import type { WikiGitState } from './wiki-snapshot-service.js';
import { loadCachedScanByGitState, persistScanCacheByGitState } from './wiki-scan-cache.js';
import type { WikiRefreshTask, DraftDocumentChange } from './contracts.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToTask(r: typeof wikiRefreshTasks.$inferSelect): WikiRefreshTask {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    baseRepoIndexId: r.baseRepoIndexId ?? null,
    nextRepoIndexId: r.nextRepoIndexId ?? null,
    status: r.status as WikiRefreshTask['status'],
    priority: r.priority as WikiRefreshTask['priority'],
    affectedDocumentIds: JSON.parse(r.affectedDocumentIdsJson) as string[],
    draftIds: JSON.parse(r.draftIdsJson) as string[],
    errorMessage: r.errorMessage ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt ?? null,
  };
}

// PLACEHOLDER_REST

async function updateTask(
  taskId: string,
  updates: Partial<typeof wikiRefreshTasks.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db.update(wikiRefreshTasks).set({
    ...updates,
    updatedAt: new Date().toISOString(),
  }).where(eq(wikiRefreshTasks.id, taskId));
}

export const wikiRefreshService = {
  async getTask(taskId: string): Promise<WikiRefreshTask | null> {
    const db = getDb();
    const rows = await db.select().from(wikiRefreshTasks).where(eq(wikiRefreshTasks.id, taskId)).limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  },

  async triggerRefresh(
    projectId: string,
    snapshotId: string,
    workDir: string,
    locale: 'zh' | 'en' = 'zh',
  ): Promise<WikiRefreshTask> {
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = nanoid();
    const workDirAbs = resolveWorkspaceRoot(workDir);

    await db.insert(wikiRefreshTasks).values({
      id: taskId,
      projectId,
      snapshotId,
      status: 'queued',
      priority: 'p1',
      affectedDocumentIdsJson: '[]',
      draftIdsJson: '[]',
      createdAt: now,
      updatedAt: now,
    });

    this._runRefresh(taskId, projectId, snapshotId, workDirAbs, locale).catch(err => {
      logger.error({ err, taskId }, 'wiki refresh: unhandled error');
    });

    return (await this.getTask(taskId))!;
  },

// PLACEHOLDER_RUN_REFRESH

  async _runRefresh(
    taskId: string,
    projectId: string,
    snapshotId: string,
    workDir: string,
    locale: 'zh' | 'en' = 'zh',
  ): Promise<void> {
    notify({
      type: TaskNotificationEventType.TaskStarted,
      taskKind: 'wiki_refresh',
      projectId,
      taskId,
      title: refreshMsg(locale).title,
      message: refreshMsg(locale).started,
      severity: 'info',
    });

    try {
      // Phase 1: scanning
      await updateTask(taskId, { status: 'scanning' });
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: refreshMsg(locale).title,
        message: refreshMsg(locale).scanning,
        severity: 'info',
        meta: { phase: 'scanning' },
      });
      const previousScan = await loadCachedScan(projectId);
      // 捕获当前 git state 并检查缓存，同一分支版本跳过重复扫描
      let gitState: WikiGitState;
      try {
        gitState = readGitState(workDir);
      } catch {
        gitState = { branch: 'unknown', headCommitSha: '0'.repeat(40), workingTreeHash: nanoid(16), dirty: false };
      }
      const cachedScan = await loadCachedScanByGitState(projectId, gitState);
      const scan = cachedScan ?? await runCodeMapScan({ projectId, workDir, include: ['all'] });
      if (!cachedScan) {
        await persistScanCacheByGitState(projectId, scan, gitState);
      }
      const nextRepoIndexId = scan.scanId;
      await updateTask(taskId, { nextRepoIndexId });

      let scanDiff: ScanDiff | null = null;
      if (previousScan) {
        scanDiff = compareScans(previousScan, scan);
        logger.info({ taskId, diffEntries: scanDiff.entries.length }, 'wiki refresh: scan diff computed');
      }
      await persistScanCache(projectId, scan);

      // Phase 2: stale detection
      await updateTask(taskId, { status: 'stale_checking' });
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: refreshMsg(locale).title,
        message: refreshMsg(locale).detecting,
        severity: 'info',
        meta: { phase: 'stale_checking' },
      });
      const snapshot = await wikiStore.getSnapshot(snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

      const baseRepoIndexId = snapshot.repoIndexId ?? nextRepoIndexId;
      await updateTask(taskId, { baseRepoIndexId });

      const changedFilePaths = new Set<string>();
      if (scanDiff) {
        for (const entry of scanDiff.entries) {
          const file = scan.codeIndex.files.find(f => f.id === entry.entityId);
          if (file) changedFilePaths.add(file.path);
        }
      }

      const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
      const affectedDocumentIds = documents
        .filter(doc => doc.references.some(ref => changedFilePaths.has(ref.filePath)))
        .map(doc => doc.id);

      await updateTask(taskId, { affectedDocumentIdsJson: JSON.stringify(affectedDocumentIds) });

      if (affectedDocumentIds.length > 0) {
        await wikiStore.markDocumentsStale(affectedDocumentIds, 'stale');
        await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.DocumentsMarkedStale);
      }

      // Phase 3: generate document drafts
      await updateTask(taskId, { status: 'drafting' });

      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: refreshMsg(locale).title,
        message: refreshMsg(locale).drafting(affectedDocumentIds.length),
        severity: 'info',
        meta: { phase: 'drafting', affectedDocuments: affectedDocumentIds.length },
      });

      const draftIds: string[] = [];
      for (const documentId of affectedDocumentIds) {
        const draftId = await this._createDocumentDraft(
          projectId, snapshotId, taskId, documentId, scan, scanDiff, locale,
        );
        if (draftId) draftIds.push(draftId);
      }

      await updateTask(taskId, {
        status: 'completed',
        draftIdsJson: JSON.stringify(draftIds),
        completedAt: new Date().toISOString(),
      });

      notify({
        type: TaskNotificationEventType.TaskCompleted,
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: refreshMsg(locale).completeTitle,
        message: refreshMsg(locale).complete(affectedDocumentIds.length, draftIds.length),
        severity: draftIds.length > 0 ? 'warning' : 'success',
        meta: { affectedDocuments: affectedDocumentIds.length, drafts: draftIds.length },
      });
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.RefreshCompleted);

      logger.info(
        { taskId, affectedDocuments: affectedDocumentIds.length, drafts: draftIds.length },
        'wiki refresh: complete',
      );
    } catch (err) {
      logger.error({ err, taskId }, 'wiki refresh: failed');
      notify({
        type: TaskNotificationEventType.TaskFailed,
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: refreshMsg(locale).failed,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      });
      await updateTask(taskId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.RefreshFailed);
    }
  },

// PLACEHOLDER_HELPERS

  async _createDocumentDraft(
    projectId: string,
    snapshotId: string,
    taskId: string,
    documentId: string,
    scan: Awaited<ReturnType<typeof runCodeMapScan>>,
    scanDiff: ScanDiff | null,
    locale: 'zh' | 'en' = 'zh',
  ): Promise<string | null> {
    const db = getDb();
    const now = new Date().toISOString();
    const draftId = nanoid();

    const doc = await wikiStore.getDocument(documentId);
    if (!doc || !doc.contentMd.trim()) return null;

    const docTitle = doc.title;
    const docType = doc.docType;
    const sourceFilesList = doc.references.map(r => r.filePath).slice(0, 15);
    const diffContext = buildDiffContext(scanDiff, sourceFilesList);

    ensureRefreshProfileRegistered();
    const handle = createRefreshTools({ document: doc, documentTitle: docTitle });
    const registeredToolIds: string[] = [];
    for (const tool of handle.tools) {
      toolRegistry.register(tool);
      registeredToolIds.push(tool.id);
    }

    try {
      const prompt = buildLanguageDirective(locale) + [
        `You are updating document "${docTitle}" (type: ${docType}).`,
        '',
        'TASK: Based on the code changes below, revise the document markdown and call refresh.submit_changes IMMEDIATELY.',
        '',
        '## Current Document',
        doc.contentMd.slice(0, 4000),
        '',
        '## Code Changes',
        `Referenced files: ${sourceFilesList.join(', ') || 'unknown'}`,
        diffContext,
        '',
        '## Instructions',
        '1. Decide whether the code changes require updating this document.',
        '2. Call refresh.submit_changes with summary, newContentMd (full revised markdown), and reasoning.',
        '3. If no updates are needed, call refresh.submit_changes with summary="No updates needed" and newContentMd equal to the current content.',
        '',
        'Do NOT explore the codebase. All context you need is above.',
      ].join('\n');

      const session = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-refresh',
        prompt,
      });

      const stream = agentLoopRuntime.streamRun(session.id, { locale });
      for await (const chunk of stream) {
        if (chunk.type === 'run_failed') {
          logger.warn({ documentId, error: chunk.error }, 'wiki refresh: agent run failed');
          break;
        }
        if (chunk.type === 'done') break;
      }

      const result = handle.getResult();
      if (!result || !result.change) return null;
      if (result.change.newContentMd.trim() === doc.contentMd.trim()) return null;

      const changes: DraftDocumentChange[] = [{
        documentId,
        oldContentMd: doc.contentMd,
        newContentMd: result.change.newContentMd,
        reasoning: result.change.reasoning,
      }];

      let sourceCommitSha: string | null = null;
      try {
        const snap = await wikiStore.getSnapshot(snapshotId);
        sourceCommitSha = snap?.headCommitSha ?? null;
      } catch { /* ignore */ }

      await db.insert(wikiRefreshDrafts).values({
        id: draftId,
        projectId,
        snapshotId,
        refreshTaskId: taskId,
        documentId,
        status: 'ready',
        changesJson: JSON.stringify(changes),
        summary: result.summary,
        sourceCommitSha,
        createdAt: now,
      });

      return draftId;
    } catch (err) {
      logger.warn({ err, documentId }, 'wiki refresh: document draft agent failed');
      return null;
    } finally {
      for (const id of registeredToolIds) {
        toolRegistry.unregister(id);
      }
    }
  },
};

// ── Scan Cache Helpers ────────────────────────────────────────────────────────

async function loadCachedScan(projectId: string): Promise<CodeMapScanResult | null> {
  try {
    const db = getDb();
    const rows = await db.select().from(wikiScanCache).where(eq(wikiScanCache.projectId, projectId)).limit(1);
    if (!rows[0]) return null;
    const row = rows[0];
    const codeIndex = JSON.parse(row.codeIndexJson);
    const communities = row.communitiesJson ? JSON.parse(row.communitiesJson) : null;
    return {
      projectId,
      scanId: row.scanId,
      generatedAt: 0,
      durationMs: 0,
      workDir: '',
      source: null,
      codeIndex,
      semanticGraph: { nodes: [], edges: [] },
      communities,
      warnings: [],
    };
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki refresh: failed to load cached scan');
    return null;
  }
}

async function persistScanCache(projectId: string, scan: CodeMapScanResult): Promise<void> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const codeIndexJson = JSON.stringify(scan.codeIndex);
    const communitiesJson = scan.communities ? JSON.stringify(scan.communities) : null;
    await db.insert(wikiScanCache).values({
      projectId,
      scanId: scan.scanId,
      codeIndexJson,
      communitiesJson,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: wikiScanCache.projectId,
      set: { scanId: scan.scanId, codeIndexJson, communitiesJson, updatedAt: now },
    });
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki refresh: failed to persist scan cache');
  }
}

function buildDiffContext(scanDiff: ScanDiff | null, sourceFiles: string[]): string {
  if (!scanDiff || scanDiff.entries.length === 0) return '';
  const relevant = scanDiff.entries
    .filter(e => !e.path || sourceFiles.some(f => e.path?.includes(f) || f.includes(e.path!)))
    .slice(0, 10);
  if (relevant.length === 0) return `\nChange summary: ${scanDiff.summary}\n`;
  const lines = relevant.map(e => {
    const path = e.path ? ` (${e.path})` : '';
    return `- ${e.kind}${path}`;
  });
  return `\nChange summary: ${scanDiff.summary}\nDetailed changes:\n${lines.join('\n')}\n`;
}
