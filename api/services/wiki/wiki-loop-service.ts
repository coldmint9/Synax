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
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiStore } from './wiki-store.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { publishLatestWikiSnapshot, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import {
  createPlannerTools,
  createWriterTools,
  type WikiDocumentDraft,
  type WikiOutlineEntry,
} from './wiki-loop-tools.js';
import type { GenerateWikiInput, GenerateWikiResult, WikiGitState } from './wiki-snapshot-service.js';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildWikiPrompt, formatLanguages } from './wiki-prompt-builder.js';
import { buildDocumentContext } from './wiki-document-context.js';
import { createVerifierTools, type WikiVerdict } from './tools/verifier-tools.js';
import type { WikiClaim } from './tools/contracts.js';

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

function readGitState(workDir: string): WikiGitState {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };
  const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const headCommitSha = run('git rev-parse HEAD') || '0'.repeat(40);
  const statusOutput = run('git status --porcelain');
  const dirty = statusOutput.length > 0;
  const workingTreeHash = createHash('sha256')
    .update(statusOutput + run('git diff --binary') + run('git diff --cached --binary'))
    .digest('hex')
    .slice(0, 16);
  return { branch, headCommitSha, workingTreeHash, dirty };
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
      const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });
      const languages = formatLanguages(scan);

      // ═══ Phase 1: Outline Generation ═══
      const plannerHandle = createPlannerTools(scan);
      for (const tool of plannerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      const plannerPrompt = buildWikiPrompt({ role: 'planner', languages, locale, scan });
      const plannerSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-planner',
        prompt: plannerPrompt,
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

      logger.info({ projectId, sessionId: plannerSession.id }, 'wiki-loop: Phase 1 starting planner agent');
      const stream1 = agentLoopRuntime.streamRun(plannerSession.id, {});
      for await (const chunk of stream1) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Planner agent failed');
        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(plannerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Planner agent was interrupted');
        }
      }

      const outline = plannerHandle.getOutline();
      if (!outline || outline.length === 0) {
        throw new Error('Planner agent did not produce an outline');
      }

      logger.info({ projectId, outlineCount: outline.length }, 'wiki-loop: Phase 1 outline received, persisting empty documents');
      const { docIds, planIdToDocId } = await persistOutlineAsEmptyDocs(outline, snapshot.id, projectId);
      await wikiStore.updateSnapshotStatus(snapshot.id, 'outline_ready', docIds);
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.OutlineReady);

      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshot.id,
        title: wikiMsg(locale).genTitle,
        message: wikiMsg(locale).outlineReady,
        severity: 'info',
        meta: { snapshotId: snapshot.id, snapshotStatus: 'outline_ready', phase: 1, docCount: docIds.length },
      });

      // ═══ Phase 2: Content Generation (per-document) ═══
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
          const commitResult = ctx.result.result as { ok: boolean; index?: number };
          if (!commitResult?.ok) return;
          const docs = writerHandle.getCommittedDocuments();
          const idx = commitResult.index ?? docs.length - 1;
          const latestDoc = docs[idx];
          if (!latestDoc) return;

          const resolvedParentId = latestDoc.parentPlanId
            ? planIdToDocId.get(latestDoc.parentPlanId) ?? null
            : null;

          const existingDocId = findExistingDocId(latestDoc, outline, planIdToDocId);
          if (existingDocId) {
            await fillDocumentContent(existingDocId, latestDoc, projectId, scan);
            await wikiStore.updateDocumentPipelineStage(existingDocId, 'drafted');
          } else {
            const newId = await persistSingleDocument(latestDoc, snapshot.id, projectId, scan, resolvedParentId);
            persistedDocIds.push(newId);
            const planEntry = outline.find(p => p.title === latestDoc.title && p.docType === latestDoc.docType);
            if (planEntry) planIdToDocId.set(planEntry.id, newId);
            await wikiStore.updateDocumentPipelineStage(newId, 'drafted');
          }

          logger.info({ projectId, title: latestDoc.title }, 'wiki-loop: document content committed');
          await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.DocumentCommitted);
        },
      });

      const sortedOutline = topologicalSort(outline);
      const totalDocs = sortedOutline.length;
      const MAX_CONCURRENT_DOCS = 3;

      // ═══ Phase 2: Writer → Skeptic → Corrector Pipeline ═══
      const processDocument = async (entry: WikiOutlineEntry, i: number) => {
        const documentContext = buildDocumentContext(scan, entry);

        const docPrompt = buildWikiPrompt({
          role: 'document-writer',
          languages,
          locale,
          documentEntry: entry,
          documentContext,
        });

        // Stage 1: Writer
        const docSession = agentSessionRuntime.create({
          projectId,
          profileId: 'wiki-document-writer',
          prompt: docPrompt,
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
        const stream = agentLoopRuntime.streamRun(docSession.id, {});
        for await (const chunk of stream) {
          if (chunk.type === 'run_failed') throw new Error(chunk.error ?? `Document writer failed for: ${entry.title}`);
          if (chunk.type === 'done') {
            const s = agentRuntimeStore.tryGetSession(docSession.id);
            if (s && s.status === 'interrupted') throw new Error(`Document writer interrupted for: ${entry.title}`);
          }
        }

        // Stage 2: Skeptic verification (only load-bearing claims)
        const committedDocs = writerHandle.getCommittedDocuments();
        const targetDoc = committedDocs.find(d => d.title === entry.title && d.docType === entry.docType)
          ?? committedDocs[committedDocs.length - 1];
        const claims: WikiClaim[] = (targetDoc as unknown as { claims?: WikiClaim[] })?.claims ?? [];
        const loadBearing = claims.filter(c => c.centrality === 'load-bearing');

        const docId = planIdToDocId.get(entry.id);

        if (loadBearing.length > 0) {
          logger.info({ projectId, docTitle: entry.title, claimCount: loadBearing.length }, 'wiki-loop: verifying claims');

          // Batch all load-bearing claims into ONE verifier session
          const verifierHandle = createVerifierTools(scan);
          for (const t of verifierHandle.tools) {
            toolRegistry.register(t);
            registeredToolIds.push(t.id);
          }

          const claimsList = loadBearing.map(c =>
            `- ID: ${c.id} | Subject: ${c.subject} | Assertion: "${c.assertion}" | Evidence hint: ${c.evidenceHint}`
          ).join('\n');

          const verifierPrompt = [
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
          });
          sessionIds.push(verifierSession.id);
          setSessionWorkspaceRoot(verifierSession.id, workDir);

          const vStream = agentLoopRuntime.streamRun(verifierSession.id, {});
          for await (const chunk of vStream) {
            if (chunk.type === 'run_failed') {
              logger.warn({ projectId, docTitle: entry.title }, 'wiki-loop: verifier failed');
              break;
            }
            if (chunk.type === 'done') break;
          }

          const verdicts = verifierHandle.getVerdicts();
          logger.info({ projectId, docTitle: entry.title, verdictCount: verdicts.length }, 'wiki-loop: verification complete');

          for (const t of verifierHandle.tools) {
            toolRegistry.unregister(t.id);
            registeredToolIds.splice(registeredToolIds.indexOf(t.id), 1);
          }

          // Stage 3: Corrector (if any claims were refuted)
          const refuted = verdicts.filter(v => v.refuted);

          if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'verified');

          if (refuted.length > 0) {
            logger.info({ projectId, docTitle: entry.title, refutedCount: refuted.length }, 'wiki-loop: correcting refuted claims');

            const corrections = refuted.map(v =>
              `- Claim "${v.claimId}": REFUTED. Evidence: ${v.evidence}. Correction: ${v.correction ?? 'remove assertion'}`
            ).join('\n');

            const correctorPrompt = [
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
            });
            sessionIds.push(correctorSession.id);
            setSessionWorkspaceRoot(correctorSession.id, workDir);

            const cStream = agentLoopRuntime.streamRun(correctorSession.id, {});
            for await (const chunk of cStream) {
              if (chunk.type === 'run_failed') {
                logger.warn({ projectId, docTitle: entry.title }, 'wiki-loop: corrector failed');
                break;
              }
              if (chunk.type === 'done') break;
            }

            if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
          } else {
            if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
          }
        } else {
          logger.debug({ projectId, docTitle: entry.title }, 'wiki-loop: no load-bearing claims, skipping verification');
          if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
        }
      };

      // Run documents with concurrency limit (topological order respected via queue)
      const queue = [...sortedOutline.entries()];
      const running: Promise<void>[] = [];

      while (queue.length > 0 || running.length > 0) {
        while (running.length < MAX_CONCURRENT_DOCS && queue.length > 0) {
          const [i, entry] = queue.shift()!;
          const task = processDocument(entry, i).then(() => {
            running.splice(running.indexOf(task), 1);
          });
          running.push(task);
        }
        if (running.length > 0) {
          await Promise.race(running);
        }
      }

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

      for (const hid of hookIds) toolRegistry.unregisterHook(hid);
      for (const tid of registeredToolIds) toolRegistry.unregister(tid);

      return { snapshotId: snapshot.id, status: 'completed' };
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

      const scan = await runCodeMapScan({ projectId: snapshot.projectId, workDir, include: ['all'] });

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

      toolRegistry.registerHook({
        id: commitHookId,
        toolId: 'wiki.commit_document',
        async afterExecute(ctx) {
          const commitResult = ctx.result.result as { ok: boolean };
          if (!commitResult?.ok) return;
          const docs = writerHandle.getCommittedDocuments();
          const latestDoc = docs[docs.length - 1];
          if (!latestDoc) return;

          const existingDoc = unfilled.find(d => d.title === latestDoc.title);
          if (existingDoc) {
            await fillDocumentContent(existingDoc.id, latestDoc, snapshot.projectId, scan);
          }
          logger.info({ projectId: snapshot.projectId, title: latestDoc.title }, 'wiki-loop: continue - document content committed');
          await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.DocumentCommitted);
        },
      });

      const writerPrompt = buildWikiPrompt({
        role: 'writer',
        languages: formatLanguages(scan),
        locale,
        outline,
        continuation: {
          completedTitles: documents.filter(d => d.blockIds.length > 0).map(d => d.title),
          remainingCount: unfilled.length,
        },
      });
      const writerSession = agentSessionRuntime.create({
        projectId: snapshot.projectId,
        profileId: 'wiki-writer',
        prompt: writerPrompt,
      });
      agentRuntimeStore.updateSession(writerSession.id, { title: wikiMsg(locale).sessionContinue, updatedAt: nowIso() });
      sessionIds.push(writerSession.id);
      setSessionWorkspaceRoot(writerSession.id, workDir);

      const stream = agentLoopRuntime.streamRun(writerSession.id, {});
      for await (const chunk of stream) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Writer agent failed');
        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(writerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Writer agent was interrupted');
        }
      }

      await wikiStore.updateSnapshotStatus(snapshotId, 'ready', documents.map(d => d.id));
      await publishLatestWikiSnapshot(snapshot.projectId, WikiSnapshotEventReason.ContinueCompleted);
      logger.info({ snapshotId, unfilledCount: unfilled.length }, 'wiki-loop: continue generation complete');
      notify({
        type: TaskNotificationEventType.TaskCompleted,
        taskKind: 'wiki_generate',
        projectId: snapshot.projectId,
        taskId: snapshotId,
        title: wikiMsg(locale).continueTitle,
        message: wikiMsg(locale).continueComplete(unfilled.length),
        severity: 'success',
        meta: { snapshotId, docCount: unfilled.length },
      });
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
      blockIds: [],
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

function findExistingDocId(
  doc: WikiDocumentDraft,
  outline: WikiOutlineEntry[],
  planIdToDocId: Map<string, string>,
): string | null {
  if (doc.parentPlanId) {
    const planEntry = outline.find(p => p.id === doc.parentPlanId);
    if (planEntry) {
      const docId = planIdToDocId.get(planEntry.id);
      if (docId) return null;
    }
  }
  const match = outline.find(p => p.title === doc.title && p.docType === doc.docType);
  if (match) return planIdToDocId.get(match.id) ?? null;
  return null;
}

async function fillDocumentContent(
  docId: string,
  draft: WikiDocumentDraft,
  projectId: string,
  scan: import('../contracts/code-map.js').CodeMapScanResult,
): Promise<void> {
  const repoIndexId = scan.scanId;
  const blockIds: string[] = [];
  const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

  for (const blockDraft of draft.blocks) {
    const block = await wikiStore.upsertBlock({
      projectId,
      documentId: docId,
      blockType: blockDraft.blockType,
      content: blockDraft.content,
      contentFormat: blockDraft.contentFormat ?? 'markdown_fragment',
      confidence: blockDraft.confidence ?? 0.5,
      generatedBy: { agentRunId: docId, model: 'wiki-writer' },
    });
    blockIds.push(block.id);

    const sourceHints = blockDraft.sourceHints ?? [];
    if (sourceHints.length > 0) {
      const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
      if (links.length > 0) blockLinkMap.push({ blockId: block.id, links });
    }
  }

  await wikiStore.updateDocumentBlockIds(docId, blockIds);
  if (blockLinkMap.length > 0) {
    await wikiCoordinateService.createBindingsFromLinks(projectId, repoIndexId, blockLinkMap, scan.codeIndex);
  }
}

async function persistSingleDocument(
  draft: WikiDocumentDraft,
  snapshotId: string,
  projectId: string,
  scan: import('../contracts/code-map.js').CodeMapScanResult,
  parentId?: string | null,
): Promise<string> {
  const repoIndexId = scan.scanId;
  const doc = await wikiStore.upsertDocument({
    snapshotId,
    projectId,
    title: draft.title,
    docType: draft.docType,
    parentId: parentId ?? null,
    sortOrder: draft.sortOrder,
    blockIds: [],
  });

  const blockIds: string[] = [];
  const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

  for (const blockDraft of draft.blocks) {
    const block = await wikiStore.upsertBlock({
      projectId,
      documentId: doc.id,
      blockType: blockDraft.blockType,
      content: blockDraft.content,
      contentFormat: blockDraft.contentFormat ?? 'markdown_fragment',
      confidence: blockDraft.confidence ?? 0.5,
      generatedBy: { agentRunId: snapshotId, model: 'wiki-writer' },
    });
    blockIds.push(block.id);

    const sourceHints = blockDraft.sourceHints ?? [];
    if (sourceHints.length > 0) {
      const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
      if (links.length > 0) blockLinkMap.push({ blockId: block.id, links });
    }
  }

  await wikiStore.updateDocumentBlockIds(doc.id, blockIds);
  if (blockLinkMap.length > 0) {
    await wikiCoordinateService.createBindingsFromLinks(projectId, repoIndexId, blockLinkMap, scan.codeIndex);
  }
  return doc.id;
}

function resolveSourceHints(
  hints: string[],
  codeIndex: import('../contracts/code-map.js').CodeMapCodeIndex,
  blockId: string,
): import('../contracts/forest.js').SourceLink[] {
  const links: import('../contracts/forest.js').SourceLink[] = [];
  for (const hint of hints) {
    const sym = codeIndex.symbols.find(s => s.qualifiedName === hint || s.name === hint);
    if (sym) {
      links.push({ id: nanoid(), nodeId: blockId, anchor: { kind: 'symbol', symbolId: sym.id }, confidence: 0.8, createdBy: 'analyzer' });
      continue;
    }
    const file = codeIndex.files.find(f => f.path === hint || f.path.endsWith(hint));
    if (file) {
      links.push({ id: nanoid(), nodeId: blockId, anchor: { kind: 'file', fileId: file.id }, confidence: 0.6, createdBy: 'analyzer' });
    }
  }
  return links;
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
