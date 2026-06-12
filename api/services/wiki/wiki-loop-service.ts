import { nanoid } from 'nanoid';
import { runCodeMapScan } from '../analyzer/scan.js';
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js';
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
import { WIKI_VERIFY_CONCURRENCY, WIKI_WRITE_CONCURRENCY } from '../../lib/env.js';
import { runBoundedConcurrency } from './bounded-concurrency.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiStore } from './wiki-store.js';
import { publishLatestWikiSnapshot, publishDocumentCommittedEvent, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import {
  createPlannerTools,
  createWriterTools,
  type WikiOutlineEntry,
} from './wiki-loop-tools.js';
import type { GenerateWikiInput, GenerateWikiResult, WikiGitState } from './wiki-snapshot-service.js';
import { readGitState } from './wiki-snapshot-service.js';
import { buildWikiPrompt, formatLanguages } from './wiki-prompt-builder.js';
import { buildDocumentContext } from './wiki-document-context.js';
import { createVerifierTools, type WikiVerdict } from './tools/verifier-tools.js';
import type { WikiClaim } from './tools/contracts.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import { mapToolCallToActivity, synthesizeActivity, scanCompleteActivity, outlineCompleteActivity } from './wiki-outline-progress.js';
import { loadCachedScanByGitState, persistScanCacheByGitState } from './wiki-scan-cache.js';
import { persistWikiDocumentCommit, toCommitInput } from './wiki-commit-persistence.js';

function wikiMsg(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    genTitle: 'Wiki Generation',
    genStarted: 'Document generation task started',
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
      gitState = readGitState(workDir);
    } catch {
      gitState = { branch: 'unknown', headCommitSha: '0'.repeat(40), workingTreeHash: nanoid(16), dirty: false };
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

      logger.info({ projectId, workDir }, 'wiki-loop: running code map scan');
      const cachedScan = await loadCachedScanByGitState(projectId, gitState);
      const scan = cachedScan ?? await runCodeMapScan({ projectId, workDir, include: ['all'] });
      if (!cachedScan) {
        await persistScanCacheByGitState(projectId, scan, gitState);
      }
      const languages = formatLanguages(scan);

      const scanActivity = scanCompleteActivity(scan.codeIndex.files.length, languages, locale);
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

      // ═══ Phase 1: Outline Generation ═══
      const plannerHandle = createPlannerTools(scan);
      for (const tool of plannerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      const plannerSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-planner',
        prompt: buildWikiPrompt({ role: 'planner', languages, locale, scan }),
        sessionMetadata: { snapshotId: snapshot.id, phase: 'planner' },
      });
      agentRuntimeStore.updateSession(plannerSession.id, { title: wikiMsg(locale).sessionInit, updatedAt: nowIso() });
      sessionIds.push(plannerSession.id);
      setSessionWorkspaceRoot(plannerSession.id, workDir);

      agentEventService.append({
        sessionId: plannerSession.id,
        type: 'progress_updated',
        summary: 'Phase 1: Generating document outline.',
        payload: { snapshotId: snapshot.id, phase: 1 },
      });

      // Phase 1b: planner agent explores, delegates to sub-agents, and produces outline
      const plannerPrompt = buildWikiPrompt({ role: 'planner', languages, locale, scan });
      logger.info({ projectId, sessionId: plannerSession.id }, 'wiki-loop: Phase 1 starting planner agent');
      const stream1 = agentLoopRuntime.streamRun(plannerSession.id, { locale, message: plannerPrompt });
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

      logger.info({ projectId, outlineCount: outline.length }, 'wiki-loop: Phase 1 outline received, persisting empty documents');
      const { docIds, planIdToDocId } = await persistOutlineAsEmptyDocs(outline, snapshot.id, projectId);
      await wikiStore.updateSnapshotStatus(snapshot.id, 'outline_ready', docIds);
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.OutlineReady);

      const outlineActivity = outlineCompleteActivity(outline.length, locale);
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: outlineActivity.activity,
        severity: 'info',
        meta: { snapshotId: snapshot.id, snapshotStatus: 'outline_ready', phase: 1, docCount: docIds.length, activity: outlineActivity.activity, activityPhase: outlineActivity.phase },
      });

      for (const tid of registeredToolIds) toolRegistry.unregister(tid);
      return { snapshotId: snapshot.id, status: 'outline_ready', docCount: docIds.length };
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
      gitState = readGitState(workDir);
    } catch {
      gitState = { branch: 'unknown', headCommitSha: '0'.repeat(40), workingTreeHash: nanoid(16), dirty: false };
    }

    const cachedScan = await loadCachedScanByGitState(snapshot.projectId, gitState);
    const scan = cachedScan ?? await runCodeMapScan({ projectId: snapshot.projectId, workDir, include: ['all'] });
    if (!cachedScan) {
      await persistScanCacheByGitState(snapshot.projectId, scan, gitState);
    }

    const outline: WikiOutlineEntry[] = documents.map(doc => ({
      id: doc.id,
      docType: doc.docType,
      title: doc.title,
      parentId: doc.parentId ?? undefined,
      sortOrder: doc.sortOrder,
      targetFiles: [],
      keyQuestions: [],
    }));
    const planIdToDocId = new Map(documents.map(d => [d.id, d.id]));
    const docIds = documents.map(d => d.id);

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
    if (snapshot.status !== 'failed') throw new Error(`Snapshot status must be "failed" to continue, got "${snapshot.status}"`);

    const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
    const unfilled = documents.filter(d => d.pipelineStage !== 'done');

    if (unfilled.length === 0) {
      await wikiStore.updateSnapshotStatus(snapshotId, 'ready', documents.map(d => d.id));
      await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueCompleted);
      return { snapshotId, status: 'completed' };
    }

    await wikiStore.updateSnapshotStatus(snapshotId, 'writing', documents.map(d => d.id));
    await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueStarted);

    const sessionIds: string[] = [];
    const registeredToolIds: string[] = [];
    const hookIds: string[] = [];

    try {
      ensureWikiProfileRegistered();

      // 捕获当前 git state 用于 git 缓存检查
      let gitState: WikiGitState;
      try {
        gitState = readGitState(workDir);
      } catch {
        gitState = { branch: 'unknown', headCommitSha: '0'.repeat(40), workingTreeHash: nanoid(16), dirty: false };
      }

      const cachedScan = await loadCachedScanByGitState(snapshot.projectId, gitState);
      const scan = cachedScan ?? await runCodeMapScan({ projectId: snapshot.projectId, workDir, include: ['all'] });
      if (!cachedScan) {
        await persistScanCacheByGitState(snapshot.projectId, scan, gitState);
      }

      const outline: WikiOutlineEntry[] = unfilled.map(doc => ({
        id: doc.id,
        docType: doc.docType as WikiOutlineEntry['docType'],
        title: doc.title,
        parentId: doc.parentId ?? undefined,
        sortOrder: doc.sortOrder,
        targetFiles: [],
        keyQuestions: [],
      }));

      const writerHandle = createWriterTools(scan, outline);
      for (const tool of writerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      const commitHookId = `wiki-continue-commit-${snapshotId}`;
      hookIds.push(commitHookId);

      const continuePlanIdToDocId = new Map(
        unfilled.map(doc => {
          const outlineEntry = outline.find(e => e.title === doc.title && e.docType === doc.docType);
          return outlineEntry ? [outlineEntry.id, doc.id] as const : null;
        }).filter((entry): entry is readonly [string, string] => entry != null),
      );

      toolRegistry.registerHook({
        id: commitHookId,
        toolId: 'wiki.commit_document',
        async afterExecute(ctx) {
          const commitResult = ctx.result.result as { ok?: boolean };
          if (!commitResult?.ok) return;
          const draft = toCommitInput(ctx.args);
          if (!draft) return;

          const committedDocId = await persistWikiDocumentCommit({
            draft,
            snapshotId: snapshot.id,
            projectId: snapshot.projectId,
            outline,
            planIdToDocId: continuePlanIdToDocId,
          });
          await wikiStore.updateDocumentPipelineStage(committedDocId, 'drafted');
          logger.info({ projectId: snapshot.projectId, title: draft.title, docId: committedDocId }, 'wiki-loop: continue - document content committed');
          await publishDocumentCommittedEvent(snapshot.projectId, committedDocId);
        },
      });

      const writerPrompt = buildWikiPrompt({
        role: 'writer',
        languages: formatLanguages(scan),
        locale,
        outline,
        continuation: {
          completedTitles: documents.filter(d => d.contentMd.trim().length > 0).map(d => d.title),
          remainingCount: unfilled.length,
        },
      });
      const writerSession = agentSessionRuntime.create({
        projectId: snapshot.projectId,
        profileId: 'wiki-writer',
        prompt: writerPrompt,
        sessionMetadata: { snapshotId: snapshot.id, phase: 'writer' },
      });
      agentRuntimeStore.updateSession(writerSession.id, { title: wikiMsg(locale).sessionContinue, updatedAt: nowIso() });
      sessionIds.push(writerSession.id);
      setSessionWorkspaceRoot(writerSession.id, workDir);

      const stream = agentLoopRuntime.streamRun(writerSession.id, { locale });
      for await (const chunk of stream) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Writer agent failed');
        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(writerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Writer agent was interrupted');
        }
      }

      // Re-check unfilled count after the writer finishes
      const updatedDocs = await wikiStore.getDocumentsBySnapshot(snapshotId);
      const stillUnfilled = updatedDocs.filter(d => d.pipelineStage !== 'done' && d.contentMd.trim().length === 0);
      const filledCount = unfilled.length - stillUnfilled.length;

      if (stillUnfilled.length > 0) {
        // Writer didn't finish all documents — mark as failed so user can continue again
        logger.warn({ snapshotId, stillUnfilled: stillUnfilled.length, filledCount }, 'wiki-loop: continue generation incomplete');
        await wikiStore.updateSnapshotStatus(snapshotId, 'failed', documents.map(d => d.id));
        await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueFailed);
        notify({
          type: TaskNotificationEventType.TaskFailed,
          taskKind: 'wiki_generate',
          projectId: snapshot.projectId,
          taskId: snapshotId,
          title: wikiMsg(locale).continueTitle,
          message: `Writer stopped after filling ${filledCount} of ${unfilled.length} documents. ${stillUnfilled.length} remain. You can continue again.`,
          severity: 'warning',
          meta: { snapshotId, docCount: filledCount, remainingCount: stillUnfilled.length },
        });
      } else {
        await wikiStore.updateSnapshotStatus(snapshotId, 'ready', documents.map(d => d.id));
        await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueCompleted);
        logger.info({ snapshotId, unfilledCount: unfilled.length }, 'wiki-loop: continue generation complete');
        notify({
          type: TaskNotificationEventType.TaskCompleted,
          taskKind: 'wiki_generate',
          projectId: snapshot.projectId,
          taskId: snapshotId,
          title: wikiMsg(locale).continueTitle,
          message: wikiMsg(locale).continueComplete(filledCount),
          severity: 'success',
          meta: { snapshotId, docCount: filledCount },
        });
      }
      return { snapshotId, status: 'completed' };
    } catch (err) {
      logger.error({ err, snapshotId }, 'wiki-loop: continue generation failed');
      notify({
        type: TaskNotificationEventType.TaskFailed,
        taskKind: 'wiki_generate',
        projectId: snapshot.projectId,
        taskId: snapshotId,
        title: wikiMsg(locale).continueFailed,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
        meta: { snapshotId },
      });
      await failSession(sessionIds[sessionIds.length - 1], err);
      await wikiStore.updateSnapshotStatus(snapshotId, 'failed');
      await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueFailed);
      return { snapshotId, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      for (const sid of sessionIds) clearSessionWorkspaceRoot(sid);
      for (const hid of hookIds) toolRegistry.unregisterHook(hid);
      for (const tid of registeredToolIds) toolRegistry.unregister(tid);
    }
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

interface WrittenDocumentResult {
  entry: WikiOutlineEntry;
  index: number;
  docId: string | undefined;
  claims: WikiClaim[];
  wasCommitted: boolean;
}

async function awaitAgentStream(
  sessionId: string,
  locale: 'zh' | 'en',
  opts?: { failOnError?: string; softFail?: boolean },
): Promise<void> {
  const stream = agentLoopRuntime.streamRun(sessionId, { locale });
  for await (const chunk of stream) {
    if (chunk.type === 'run_failed') {
      if (opts?.softFail) {
        logger.warn({ sessionId, error: chunk.error }, 'wiki-loop: agent run failed (soft)');
        return;
      }
      throw new Error(chunk.error ?? opts?.failOnError ?? 'Agent run failed');
    }
    if (chunk.type === 'done') {
      const s = agentRuntimeStore.tryGetSession(sessionId);
      if (s?.status === 'interrupted') {
        if (opts?.softFail) return;
        throw new Error(opts?.failOnError ?? 'Agent run was interrupted');
      }
    }
  }
}

async function runWritingPhase(input: WritingPhaseInput): Promise<GenerateWikiResult> {
  const { snapshot, workDir, locale, scan, outline, planIdToDocId, docIds, languages } = input;
  const projectId = snapshot.projectId;
  const sessionIds: string[] = [];
  const registeredToolIds: string[] = [];
  const hookIds: string[] = [];

  try {
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
      meta: { snapshotId: snapshot.id, snapshotStatus: 'writing', phase: 2, totalDocs: docIds.length },
    });

    const writerHandle = createWriterTools(scan, outline);
    for (const tool of writerHandle.tools) {
      toolRegistry.register(tool);
      registeredToolIds.push(tool.id);
    }

    const commitHookId = `wiki-commit-${snapshot.id}`;
    hookIds.push(commitHookId);
    const persistedDocIds = [...docIds];

    toolRegistry.registerHook({
      id: commitHookId,
      toolId: 'wiki.commit_document',
      async afterExecute(ctx) {
        const commitResult = ctx.result.result as { ok?: boolean };
        if (!commitResult?.ok) return;
        const draft = toCommitInput(ctx.args);
        if (!draft) return;

        const committedDocId = await persistWikiDocumentCommit({
          draft,
          snapshotId: snapshot.id,
          projectId,
          outline,
          planIdToDocId,
        });

        if (!persistedDocIds.includes(committedDocId)) {
          persistedDocIds.push(committedDocId);
        }
        await wikiStore.updateDocumentPipelineStage(committedDocId, 'drafted');
        logger.info({ projectId, title: draft.title, docId: committedDocId }, 'wiki-loop: document content committed');
        await publishDocumentCommittedEvent(projectId, committedDocId);
      },
    });

    const sortedOutline = topologicalSort(outline);
    const totalDocs = sortedOutline.length;
    const writeConcurrency = WIKI_WRITE_CONCURRENCY;
    const verifyConcurrency = WIKI_VERIFY_CONCURRENCY;

    logger.info(
      { projectId, totalDocs, writeConcurrency, verifyConcurrency },
      'wiki-loop: Phase 2 starting (write then verify)',
    );

    const writtenResults: WrittenDocumentResult[] = new Array(totalDocs);

    const writeDocument = async (entry: WikiOutlineEntry, i: number) => {
      const documentContext = buildDocumentContext(scan, entry);

      const docPrompt = buildWikiPrompt({
        role: 'document-writer',
        languages,
        locale,
        documentEntry: entry,
        documentContext,
      });

      const docSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-document-writer',
        prompt: docPrompt,
        sessionMetadata: { snapshotId: snapshot.id, phase: 'document-writer', docTitle: entry.title },
      });
      agentRuntimeStore.updateSession(docSession.id, {
        title: `Wiki: ${entry.title}`,
        updatedAt: nowIso(),
      });
      sessionIds.push(docSession.id);
      setSessionWorkspaceRoot(docSession.id, workDir);

      agentEventService.append({
        sessionId: docSession.id,
        type: 'progress_updated',
        summary: `Phase 2: Generating document ${i + 1}/${totalDocs}: ${entry.title}`,
        payload: { snapshotId: snapshot.id, phase: 2, docIndex: i, docTitle: entry.title },
      });

      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: wikiMsg(locale).generating(entry.title, i + 1, totalDocs),
        severity: 'info',
        meta: { snapshotId: snapshot.id, snapshotStatus: 'writing', phase: 2, docIndex: i, totalDocs, docTitle: entry.title },
      });

      logger.info({ projectId, docTitle: entry.title, index: i, total: totalDocs }, 'wiki-loop: generating document');
      await awaitAgentStream(docSession.id, locale, {
        failOnError: `Document writer failed for: ${entry.title}`,
      });

      const committedDocs = writerHandle.getCommittedDocuments();
      const targetDoc = committedDocs.find(d => d.title === entry.title && d.docType === entry.docType);

      const docId = planIdToDocId.get(entry.id);
      const docAfterWriter = docId ? await wikiStore.getDocument(docId) : null;
      const wasCommitted = docAfterWriter != null && docAfterWriter.contentMd.trim().length > 0;
      if (!wasCommitted) {
        logger.warn({ projectId, docTitle: entry.title, docId }, 'wiki-loop: writer completed but document was not committed — skipping verification');
      }

      writtenResults[i] = {
        entry,
        index: i,
        docId,
        claims: targetDoc?.claims ?? [],
        wasCommitted,
      };
    };

    await runBoundedConcurrency(sortedOutline, writeConcurrency, writeDocument);

    const verifierHandle = createVerifierTools(scan);
    for (const t of verifierHandle.tools) {
      toolRegistry.register(t);
      registeredToolIds.push(t.id);
    }

    const verifyDocument = async (result: WrittenDocumentResult) => {
      const { entry, docId, claims, wasCommitted } = result;
      if (!wasCommitted) return;

      const loadBearing = claims.filter(c => c.centrality === 'load-bearing');
      if (loadBearing.length === 0) {
        logger.debug({ projectId, docTitle: entry.title }, 'wiki-loop: no load-bearing claims, skipping verification');
        if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
        return;
      }

      logger.info({ projectId, docTitle: entry.title, claimCount: loadBearing.length }, 'wiki-loop: verifying claims');

      const claimsList = loadBearing.map(c =>
        `- ID: ${c.id} | Subject: ${c.subject} | Assertion: "${c.assertion}" | Evidence hint: ${c.evidenceHint}`,
      ).join('\n');

      const verifierPrompt = buildLanguageDirective(locale) + [
        `Verify the following claims by reading the actual source code.`,
        `For each claim, call wiki.submit_verdict with your findings.`,
        `If you cannot find supporting evidence for a claim, default to refuted=true.`,
        ``,
        `## Claims to verify`,
        claimsList,
        ``,
        `Language composition: ${languages}`,
      ].join('\n');

      const verifierSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-verifier',
        prompt: verifierPrompt,
        sessionMetadata: { snapshotId: snapshot.id, phase: 'verifier', docTitle: entry.title },
      });
      sessionIds.push(verifierSession.id);
      setSessionWorkspaceRoot(verifierSession.id, workDir);

      await awaitAgentStream(verifierSession.id, locale, { softFail: true });

      const verdicts = verifierHandle.getVerdicts(verifierSession.id);
      verifierHandle.clearVerdicts(verifierSession.id);
      logger.info({ projectId, docTitle: entry.title, verdictCount: verdicts.length }, 'wiki-loop: verification complete');

      const refuted = verdicts.filter((v: WikiVerdict) => v.refuted);
      if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'verified');

      if (refuted.length > 0) {
        logger.info({ projectId, docTitle: entry.title, refutedCount: refuted.length }, 'wiki-loop: correcting refuted claims');

        const corrections = refuted.map(v =>
          `- Claim "${v.claimId}": REFUTED. Evidence: ${v.evidence}. Correction: ${v.correction ?? 'remove assertion'}`,
        ).join('\n');

        const correctorPrompt = buildLanguageDirective(locale) + [
          `You are rewriting a wiki document to fix factual errors found by verification.`,
          ``,
          `Document: "${entry.title}" (${entry.docType})`,
          ``,
          `The following claims were refuted with evidence:`,
          corrections,
          ``,
          `Rewrite the document incorporating the corrections. Keep all other content intact.`,
          `Call wiki.commit_document when done. Include updated claims.`,
        ].join('\n');

        const correctorSession = agentSessionRuntime.create({
          projectId,
          profileId: 'wiki-document-writer',
          prompt: correctorPrompt,
          sessionMetadata: { snapshotId: snapshot.id, phase: 'corrector', docTitle: entry.title },
        });
        sessionIds.push(correctorSession.id);
        setSessionWorkspaceRoot(correctorSession.id, workDir);

        await awaitAgentStream(correctorSession.id, locale, { softFail: true });

        if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
      } else if (docId) {
        await wikiStore.updateDocumentPipelineStage(docId, 'done');
      }
    };

    const toVerify = writtenResults.filter((r): r is WrittenDocumentResult => r != null);
    await runBoundedConcurrency(toVerify, verifyConcurrency, verifyDocument);

    await wikiStore.updateSnapshotStatus(snapshot.id, 'ready', persistedDocIds);
    await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.GenerationCompleted);
    logger.info({ projectId, snapshotId: snapshot.id, docCount: persistedDocIds.length }, 'wiki-loop: generation complete');
    notify({
      type: TaskNotificationEventType.TaskCompleted,
      taskKind: 'wiki_generate',
      projectId,
      taskId: snapshot.id,
      title: wikiMsg(locale).genTitle,
      message: wikiMsg(locale).genComplete(persistedDocIds.length),
      severity: 'success',
      meta: { snapshotId: snapshot.id, docCount: persistedDocIds.length },
    });

    return { snapshotId: snapshot.id, status: 'completed' };
  } catch (err) {
    logger.error({ err, projectId, snapshotId: snapshot.id }, 'wiki-loop: writing phase failed');
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
    for (const hid of hookIds) toolRegistry.unregisterHook(hid);
    for (const tid of registeredToolIds) toolRegistry.unregister(tid);
  }
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
