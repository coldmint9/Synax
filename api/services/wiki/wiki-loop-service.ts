import { agentEventService } from '../agent-runtime/event-service.js';
import { nowIso } from '../agent-runtime/runtime-ids.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import {
  clearSessionWorkspaceRoot,
  resolveWorkspaceRoot,
  setSessionWorkspaceRoot,
} from '../agent-runtime/tools/workspace.js';
import { logger } from '../../lib/logger.js';
import { wikiWriteQueue } from './wiki-write-queue-service.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiStore } from './wiki-store.js';
import { publishLatestWikiSnapshot, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import {
  createPlannerTools,
  type WikiOutlineEntry,
} from './wiki-loop-tools.js';
import type { GenerateWikiInput, GenerateWikiResult, WikiGitState } from './wiki-snapshot-service.js';
import { readGitState } from './wiki-snapshot-service.js';
import { buildWikiPrompt, formatLanguages } from './wiki-prompt-builder.js';
import { mapToolCallToActivity, synthesizeActivity, scanCompleteActivity, scanCheckingActivity, outlineCompleteActivity } from './wiki-outline-progress.js';
import { acquireCodeMapScan, fallbackGitState } from './wiki-scan-cache.js';
import { streamWikiAgent } from './wiki-agent-stream.js';
import { assertCanStartAgentSessionProcess } from '../agent-runtime/agent-stream-proxy.js';
import { countWritableOutlineEntries, isSectionEntry, isWritableOutlineEntry } from './tools/outline-node.js';

function wikiMsg(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    genTitle: 'Wiki Generation',
    genStarted: 'Document generation task started',
    scanChecking: 'Checking code analysis cache',
    skeletonGenerating: 'Generating document skeleton',
    preparingPlanner: 'Preparing planner tools and session',
    outlineReady: 'Document outline ready, preparing to generate content',
    writingContent: 'Writing document content',
    generating: (title: string, i: number, total: number) => `Generating: ${title} (${i}/${total})`,
    genComplete: (count: number) => `Successfully generated ${count} documents`,
    genFailed: 'Wiki Generation Failed',
    continueTitle: 'Wiki Continue Generation',
    continueComplete: (count: number) => `Successfully completed ${count} documents`,
    continueFailed: 'Wiki Continue Generation Failed',
    sessionInit: 'Wiki Initialization',
    sessionContinue: 'Wiki Continue Generation',
  } : {
    genTitle: 'Wiki 生成',
    genStarted: '文档生成任务已启动',
    scanChecking: '正在查找代码分析缓存',
    skeletonGenerating: '正在生成文档骨架',
    preparingPlanner: '正在准备 planner 工具与会话',
    outlineReady: '文档大纲已就绪，准备生成内容',
    writingContent: '正在撰写文档内容',
    generating: (title: string, i: number, total: number) => `正在生成: ${title} (${i}/${total})`,
    genComplete: (count: number) => `成功生成 ${count} 篇文档`,
    genFailed: 'Wiki 生成失败',
    continueTitle: 'Wiki 继续生成',
    continueComplete: (count: number) => `成功补全 ${count} 篇文档`,
    continueFailed: 'Wiki 继续生成失败',
    sessionInit: 'Wiki 初始化',
    sessionContinue: 'Wiki 继续生成',
  };
}

export const wikiLoopService = {
  async generate(input: GenerateWikiInput): Promise<GenerateWikiResult> {
    const { projectId, locale = 'zh' } = input;
    const workDir = resolveWorkspaceRoot(input.workDir);

    let gitState: WikiGitState;
    try {
      gitState = await readGitState(workDir);
    } catch {
      gitState = fallbackGitState();
    }

    const snapshot = await wikiStore.createSnapshot({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha,
      workingTreeHash: gitState.workingTreeHash,
      createdBy: 'agent',
    });
    await wikiStore.updateSnapshotStatus(snapshot.id, 'refreshing');
    await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.GenerationStarted);

    notify({
      type: TaskNotificationEventType.TaskStarted,
      taskKind: 'wiki_generate',
      projectId,
      taskId: snapshot.id,
      title: wikiMsg(locale).genTitle,
      message: wikiMsg(locale).genStarted,
      severity: 'info',
      meta: { snapshotId: snapshot.id },
    });

    const sessionIds: string[] = [];
    const registeredToolIds: string[] = [];
    const hookIds: string[] = [];

    try {
      ensureWikiProfileRegistered();

      const checkingActivity = scanCheckingActivity(locale);
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: checkingActivity.activity,
        severity: 'info',
        meta: { snapshotId: snapshot.id, snapshotStatus: 'refreshing', phase: 1, activity: checkingActivity.activity, activityPhase: checkingActivity.phase },
      });

      const { scan, fromCache } = await acquireCodeMapScan({ projectId, workDir, gitState });
      const languages = formatLanguages(scan);

      const scanActivity = scanCompleteActivity(scan.codeIndex.files.length, languages, locale, fromCache);
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: scanActivity.activity,
        severity: 'info',
        meta: { snapshotId: snapshot.id, snapshotStatus: 'refreshing', phase: 1, activity: scanActivity.activity, activityPhase: scanActivity.phase },
      });

      // ═══ Phase 1: Outline Generation (planner agent + tool-call outline) ═══
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: wikiMsg(locale).preparingPlanner,
        severity: 'info',
        meta: {
          snapshotId: snapshot.id,
          snapshotStatus: 'refreshing',
          phase: 1,
          activity: wikiMsg(locale).preparingPlanner,
          activityPhase: 'plan',
        },
      });

      logger.info({ projectId, snapshotId: snapshot.id, fileCount: scan.codeIndex.files.length }, 'wiki-loop: preparing planner tools');
      const toolsStarted = Date.now();
      const plannerHandle = createPlannerTools(scan);
      for (const tool of plannerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }
      logger.info(
        {
          projectId,
          snapshotId: snapshot.id,
          toolCount: plannerHandle.tools.length,
          durationMs: Date.now() - toolsStarted,
        },
        'wiki-loop: planner tools ready',
      );

      logger.info({ projectId, snapshotId: snapshot.id, profileId: 'wiki-planner' }, 'wiki-loop: creating planner session');
      assertCanStartAgentSessionProcess();
      const plannerSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-planner',
        prompt: buildWikiPrompt({ role: 'planner', languages, locale, scan, workDir }),
        sessionMetadata: { snapshotId: snapshot.id, phase: 'planner' },
      });
      agentRuntimeStore.updateSession(plannerSession.id, { title: wikiMsg(locale).sessionInit, updatedAt: nowIso() });
      sessionIds.push(plannerSession.id);
      setSessionWorkspaceRoot(plannerSession.id, workDir);
      logger.info(
        { projectId, snapshotId: snapshot.id, sessionId: plannerSession.id, title: wikiMsg(locale).sessionInit },
        'wiki-loop: planner session ready',
      );

      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: wikiMsg(locale).skeletonGenerating,
        severity: 'info',
        meta: {
          snapshotId: snapshot.id,
          snapshotStatus: 'refreshing',
          phase: 1,
          activity: wikiMsg(locale).skeletonGenerating,
          activityPhase: 'plan',
          sessionId: plannerSession.id,
        },
      });

      agentEventService.append({
        sessionId: plannerSession.id,
        type: 'progress_updated',
        summary: 'Phase 1: Generating document outline.',
        payload: { snapshotId: snapshot.id, phase: 1 },
      });

      // Phase 1b: planner agent explores, delegates to sub-agents, and produces outline
      const plannerPrompt = buildWikiPrompt({ role: 'planner', languages, locale, scan, workDir });
      logger.info({ projectId, sessionId: plannerSession.id }, 'wiki-loop: Phase 1 starting planner agent');
      const stream1 = streamWikiAgent(plannerSession.id, { locale, message: plannerPrompt });
      let lastActivityTs = 0;
      const ACTIVITY_THROTTLE_MS = 800;
      const SYNTHESIZE_THROTTLE_MS = 2000;
      for await (const chunk of stream1) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Planner agent failed');

        if (chunk.type === 'tool_call') {
          const toolId = chunk.toolCall?.toolId ?? '';
          const args = chunk.toolCall?.inputRef;
          const activity = mapToolCallToActivity(toolId, args);
          if (activity && (Date.now() - lastActivityTs > ACTIVITY_THROTTLE_MS || activity.phase === 'submit')) {
            lastActivityTs = Date.now();
            notify({
              type: TaskNotificationEventType.TaskProgress,
              taskKind: 'wiki_generate',
              projectId,
              taskId: snapshot.id,
              title: wikiMsg(locale).genTitle,
              message: activity.activity,
              severity: 'info',
              meta: {
                snapshotId: snapshot.id,
                snapshotStatus: 'refreshing',
                phase: 1,
                activity: activity.activity,
                detail: activity.detail,
                activityPhase: activity.phase,
              },
            });
          }
        }

        if (chunk.type === 'thought_delta' && Date.now() - lastActivityTs > SYNTHESIZE_THROTTLE_MS) {
          lastActivityTs = Date.now();
          const synth = synthesizeActivity(locale);
          notify({
            type: TaskNotificationEventType.TaskProgress,
            taskKind: 'wiki_generate',
            projectId,
            taskId: snapshot.id,
            title: wikiMsg(locale).genTitle,
            message: synth.activity,
            severity: 'info',
            meta: {
              snapshotId: snapshot.id,
              snapshotStatus: 'refreshing',
              phase: 1,
              activity: synth.activity,
              activityPhase: synth.phase,
            },
          });
        }

        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(plannerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Planner agent was interrupted');
        }
      }

      const outline = plannerHandle.getOutline();
      if (!outline || outline.length === 0) {
        const draft = plannerHandle.getDraft();
        if (draft && draft.documents.length > 0 && !draft.locked) {
          throw new Error('Planner agent created an outline draft but did not call wiki.submit_outline to lock it. ' +
            `Draft has ${draft.documents.length} documents with ${draft.validationErrors.length} unresolved issues.`);
        }
        throw new Error('Planner agent did not produce an outline');
      }

      const result = await finalizeOutlineReady(outline, snapshot.id, projectId, locale);
      for (const tid of registeredToolIds) toolRegistry.unregister(tid);
      return result;
    } catch (err) {
      logger.error({ err, projectId, snapshotId: snapshot.id }, 'wiki-loop: generation failed');
      notify({
        type: TaskNotificationEventType.TaskFailed,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genFailed,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
        meta: { snapshotId: snapshot.id },
      });
      await failSession(sessionIds[sessionIds.length - 1], err);
      await wikiStore.updateSnapshotStatus(snapshot.id, 'failed');
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.GenerationFailed);
      return { snapshotId: snapshot.id, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      for (const sid of sessionIds) clearSessionWorkspaceRoot(sid);
    }
  },

  async approveOutline(input: { snapshotId: string; workDir: string; locale?: 'zh' | 'en' }): Promise<GenerateWikiResult> {
    const { snapshotId, locale = 'zh' } = input;
    const workDir = resolveWorkspaceRoot(input.workDir);

    const snapshot = await wikiStore.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);
    if (snapshot.status !== 'outline_ready') {
      throw new Error(`Snapshot status must be outline_ready to approve, got "${snapshot.status}"`);
    }

    const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
    if (documents.length === 0) throw new Error('No documents in snapshot to write');

    ensureWikiProfileRegistered();

    let gitState: WikiGitState;
    try {
      gitState = await readGitState(workDir);
    } catch {
      gitState = fallbackGitState();
    }

    const { scan } = await acquireCodeMapScan({ projectId: snapshot.projectId, workDir, gitState });

    const outline: WikiOutlineEntry[] = documents.map(doc => ({
      id: doc.id,
      nodeKind: doc.isSection ? 'section' : 'document',
      docType: doc.docType,
      title: doc.title,
      parentId: doc.parentId ?? undefined,
      sortOrder: doc.sortOrder,
      targetFiles: [],
      keyQuestions: [],
    }));
    const planIdToDocId = new Map(documents.map(d => [d.id, d.id]));
    const docIds = documents.filter(d => !d.isSection).map(d => d.id);

    return runWritingPhase({
      snapshot,
      workDir,
      locale,
      scan,
      outline,
      planIdToDocId,
      docIds,
      languages: formatLanguages(scan),
    });
  },

  async continueGeneration(input: { snapshotId: string; workDir: string; locale?: 'zh' | 'en' }): Promise<GenerateWikiResult> {
    const { snapshotId, locale = 'zh' } = input;
    const workDir = resolveWorkspaceRoot(input.workDir);

    const snapshot = await wikiStore.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);
    if (snapshot.status !== 'failed' && snapshot.status !== 'partial') {
      throw new Error(`Snapshot status must be "failed" or "partial" to continue, got "${snapshot.status}"`);
    }

    const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
    const unfilled = documents.filter(d => !d.isSection && d.pipelineStage !== 'done' && d.contentMd.trim().length === 0);

    if (unfilled.length === 0) {
      await wikiStore.updateSnapshotStatus(snapshotId, 'ready', documents.map(d => d.id));
      await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueCompleted);
      return { snapshotId, status: 'completed' };
    }

    ensureWikiProfileRegistered();

    await wikiStore.updateSnapshotStatus(snapshotId, 'writing', documents.map(d => d.id));
    await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueStarted);

    notify({
      type: TaskNotificationEventType.TaskProgress,
      taskKind: 'wiki_generate',
      projectId: snapshot.projectId,
      taskId: snapshotId,
      title: wikiMsg(locale).continueTitle,
      message: wikiMsg(locale).writingContent,
      severity: 'info',
      meta: { snapshotId, snapshotStatus: 'writing', phase: 2, totalDocs: unfilled.length },
    });

    const sorted = [...unfilled].sort((a, b) => a.sortOrder - b.sortOrder);
    await wikiWriteQueue.enqueueBatch({
      snapshotId,
      projectId: snapshot.projectId,
      workDir,
      locale,
      items: sorted.map((doc, i) => ({
        documentId: doc.id,
        documentTitle: doc.title,
        sortOrder: i,
      })),
    });

    return { snapshotId, status: 'writing' };
  },
};

interface WritingPhaseInput {
  snapshot: { id: string; projectId: string };
  workDir: string;
  locale: 'zh' | 'en';
  scan: import('../contracts/code-map.js').CodeMapScanResult;
  outline: WikiOutlineEntry[];
  planIdToDocId: Map<string, string>;
  docIds: string[];
  languages: string;
}

async function runWritingPhase(input: WritingPhaseInput): Promise<GenerateWikiResult> {
  const { snapshot, workDir, locale, outline, planIdToDocId, docIds } = input;
  const projectId = snapshot.projectId;

  const sortedOutline = topologicalSort(outline).filter(isWritableOutlineEntry);
  const totalDocs = sortedOutline.length;

  await wikiStore.updateSnapshotStatus(snapshot.id, 'writing', docIds);
  await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.WritingStarted);

  notify({
    type: TaskNotificationEventType.TaskProgress,
    taskKind: 'wiki_generate',
    projectId,
    taskId: snapshot.id,
    title: wikiMsg(locale).genTitle,
    message: wikiMsg(locale).writingContent,
    severity: 'info',
    meta: { snapshotId: snapshot.id, snapshotStatus: 'writing', phase: 2, totalDocs },
  });

  logger.info({ projectId, totalDocs }, 'wiki-loop: Phase 2 enqueued to write queue');

  await wikiWriteQueue.enqueueBatch({
    snapshotId: snapshot.id,
    projectId,
    workDir,
    locale,
    items: sortedOutline.map((entry, i) => ({
      documentId: planIdToDocId.get(entry.id) ?? entry.id,
      documentTitle: entry.title,
      sortOrder: i,
    })),
  });

  return { snapshotId: snapshot.id, status: 'writing' };
}

/** Persist the outline as empty docs, flip the snapshot to outline_ready, and notify. */
async function finalizeOutlineReady(
  outline: WikiOutlineEntry[],
  snapshotId: string,
  projectId: string,
  locale: 'zh' | 'en',
): Promise<GenerateWikiResult> {
  logger.info({ projectId, outlineCount: outline.length, writableCount: countWritableOutlineEntries(outline) }, 'wiki-loop: Phase 1 outline received, persisting empty documents');
  const { docIds } = await persistOutlineAsEmptyDocs(outline, snapshotId, projectId);
  await wikiStore.updateSnapshotStatus(snapshotId, 'outline_ready', docIds);
  await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.OutlineReady);

  const outlineActivity = outlineCompleteActivity(countWritableOutlineEntries(outline), locale);
  notify({
    type: TaskNotificationEventType.TaskProgress,
    taskKind: 'wiki_generate',
    projectId,
    taskId: snapshotId,
    title: wikiMsg(locale).genTitle,
    message: outlineActivity.activity,
    severity: 'info',
    meta: { snapshotId, snapshotStatus: 'outline_ready', phase: 1, docCount: countWritableOutlineEntries(outline), activity: outlineActivity.activity, activityPhase: outlineActivity.phase },
  });

  return { snapshotId, status: 'outline_ready', docCount: countWritableOutlineEntries(outline) };
}

async function persistOutlineAsEmptyDocs(
  outline: WikiOutlineEntry[],
  snapshotId: string,
  projectId: string,
): Promise<{ docIds: string[]; planIdToDocId: Map<string, string> }> {
  const planIdToDocId = new Map<string, string>();
  const docIds: string[] = [];

  const sorted = topologicalSort(outline);
  for (const entry of sorted) {
    const parentId = entry.parentId ? planIdToDocId.get(entry.parentId) ?? null : null;
    const doc = await wikiStore.upsertDocument({
      snapshotId,
      projectId,
      title: entry.title,
      docType: entry.docType,
      parentId,
      sortOrder: entry.sortOrder ?? 0,
      contentMd: '',
      references: [],
      isSection: isSectionEntry(entry),
      pipelineStage: isSectionEntry(entry) ? 'done' : 'pending',
    });
    planIdToDocId.set(entry.id, doc.id);
    docIds.push(doc.id);
  }

  return { docIds, planIdToDocId };
}

function topologicalSort(entries: WikiOutlineEntry[]): WikiOutlineEntry[] {
  const sorted: WikiOutlineEntry[] = [];
  const visited = new Set<string>();
  const visit = (entry: WikiOutlineEntry) => {
    if (visited.has(entry.id)) return;
    if (entry.parentId) {
      const parent = entries.find(e => e.id === entry.parentId);
      if (parent) visit(parent);
    }
    visited.add(entry.id);
    sorted.push(entry);
  };
  for (const entry of entries) visit(entry);
  return sorted;
}

async function failSession(sessionId: string | undefined, err: unknown): Promise<void> {
  if (!sessionId) return;
  const message = err instanceof Error ? err.message : String(err);
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) {
    agentRuntimeStore.updateSession(sessionId, {
      status: 'failed',
      updatedAt: nowIso(),
      completedAt: nowIso(),
      blockedReason: message,
      resultSummary: message,
      activeRunId: null,
      pendingResumeToken: null,
    });
  }
  if (session) {
    agentEventService.append({
      sessionId,
      type: 'session_failed',
      summary: message,
      payload: { error: message },
    });
  }
}
