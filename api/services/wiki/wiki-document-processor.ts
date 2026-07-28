/**
 * Process a single wiki document (write → verify → optional correct) for the write queue.
 */
import { streamWikiAgent } from './wiki-agent-stream.js';
import { assertCanStartAgentSessionProcess } from '../agent-runtime/agent-stream-proxy.js';
import { agentEventService } from '../agent-runtime/event-service.js';
import { nowIso } from '../agent-runtime/runtime-ids.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from '../agent-runtime/tools/workspace.js';
import { logger } from '../../lib/logger.js';
import { WIKI_AGENT_RUN_TIMEOUT_MS } from '../../lib/env.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiStore } from './wiki-store.js';
import { countSnapshotWritingProgress } from './wiki-writing-progress.js';
import { buildWikiPrompt, formatLanguages } from './wiki-prompt-builder.js';
import { buildDocumentContext } from './wiki-document-context.js';
import { createVerifierTools, type WikiVerdict } from './tools/verifier-tools.js';
import type { WikiOutlineEntry } from './tools/contracts.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import { acquireCodeMapScan, fallbackGitState } from './wiki-scan-cache.js';
import { readGitState } from './wiki-snapshot-service.js';
import { wikiSessionToolProvider } from './wiki-session-tool-provider.js';
import type { WikiWriteBatch, WikiWriteQueueItem } from './wiki-write-queue-service.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';

function wikiMsg(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    genTitle: 'Wiki Generation',
    generating: (title: string, i: number, total: number) => `Generating: ${title} (${i}/${total})`,
  } : {
    genTitle: 'Wiki 生成',
    generating: (title: string, i: number, total: number) => `正在生成: ${title} (${i}/${total})`,
  };
}

async function awaitAgentStream(
  sessionId: string,
  locale: 'zh' | 'en',
  opts?: { failOnError?: string; softFail?: boolean; abortSignal?: AbortSignal },
): Promise<void> {
  const timeoutMs = WIKI_AGENT_RUN_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(
      new Error(`Wiki agent run timed out after ${Math.round(timeoutMs / 60_000)} minutes`),
    );
  }, timeoutMs);

  const signals: AbortSignal[] = [timeoutController.signal];
  if (opts?.abortSignal) signals.push(opts.abortSignal);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('Aborted')), { once: true });
  }

  try {
    const stream = streamWikiAgent(sessionId, { locale }, controller.signal);
    for await (const chunk of stream) {
      if (chunk.type === 'run_failed') {
        if (opts?.softFail) {
          logger.warn({ sessionId, error: chunk.error }, 'wiki-document-processor: soft fail');
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
  } finally {
    clearTimeout(timeoutTimer);
  }
}

export interface ProcessQueueDocumentInput {
  batch: WikiWriteBatch;
  item: WikiWriteQueueItem;
  entry: WikiOutlineEntry;
  itemIndex: number;
  totalItems: number;
  outline: WikiOutlineEntry[];
  planIdToDocId: Map<string, string>;
  scan: CodeMapScanResult;
  verifierHandle: ReturnType<typeof createVerifierTools>;
  onWriterSessionCreated?: (sessionId: string) => void | Promise<void>;
}

export async function processQueueDocument(input: ProcessQueueDocumentInput): Promise<void> {
  const {
    batch, item, entry, itemIndex, totalItems, outline, planIdToDocId, scan, verifierHandle,
    onWriterSessionCreated,
  } = input;
  const { projectId, snapshotId, workDir, locale } = batch;
  const languages = formatLanguages(scan);

  const sessionIds: string[] = [];

  try {
    const documentContext = buildDocumentContext(scan, entry);
    const docPrompt = buildWikiPrompt({
      role: 'document-writer',
      languages,
      locale,
      projectId,
      workDir,
      documentEntry: entry,
      documentContext,
    });

    assertCanStartAgentSessionProcess();
    const docSession = agentSessionRuntime.create({
      projectId,
      profileId: 'wiki-document-writer',
      prompt: docPrompt,
      sessionMetadata: {
        snapshotId,
        phase: 'document-writer',
        documentId: item.documentId,
        docTitle: entry.title,
        queueItemId: item.id,
      },
    });
    agentRuntimeStore.updateSession(docSession.id, {
      title: `Wiki: ${entry.title}`,
      updatedAt: nowIso(),
    });
    sessionIds.push(docSession.id);
    setSessionWorkspaceRoot(docSession.id, workDir);
    await onWriterSessionCreated?.(docSession.id);

    agentEventService.append({
      sessionId: docSession.id,
      type: 'progress_updated',
      summary: `Phase 2: Generating document ${itemIndex + 1}/${totalItems}: ${entry.title}`,
      payload: { snapshotId, phase: 2, docIndex: itemIndex, docTitle: entry.title, queueItemId: item.id },
    });

    const { doneDocs, totalDocs } = await countSnapshotWritingProgress(snapshotId);

    notify({
      type: TaskNotificationEventType.TaskProgress,
      taskKind: 'wiki_generate',
      projectId,
      taskId: snapshotId,
      title: wikiMsg(locale).genTitle,
      message: wikiMsg(locale).generating(entry.title, itemIndex + 1, totalItems),
      severity: 'info',
      meta: {
        snapshotId,
        snapshotStatus: 'writing',
        phase: 2,
        docIndex: itemIndex,
        batchTotalDocs: totalItems,
        doneDocs,
        totalDocs,
        documentId: item.documentId,
        docTitle: entry.title,
        queueItemId: item.id,
      },
    });

    await awaitAgentStream(docSession.id, locale, {
      failOnError: `Document writer failed for: ${entry.title}`,
    });

    const committedDocs = wikiSessionToolProvider.getCommittedDocuments(docSession.id);
    const targetDoc = committedDocs.find(d => d.title === entry.title && d.docType === entry.docType);

    const docId = planIdToDocId.get(entry.id);
    const docAfterWriter = docId ? await wikiStore.getDocument(docId) : null;
    const wasCommitted = docAfterWriter != null && docAfterWriter.contentMd.trim().length > 0;
    if (!wasCommitted) {
      throw new Error(`Document "${entry.title}" was not committed after writing.`);
    }

    await runVerificationIfNeeded({
      batch,
      entry,
      docId,
      wasCommitted,
      claims: targetDoc?.claims ?? [],
      languages,
      locale,
      workDir,
      sessionIds,
      verifierHandle,
    });
  } finally {
    for (const sid of sessionIds) {
      clearSessionWorkspaceRoot(sid);
      wikiSessionToolProvider.clearSessionTools(sid);
    }
  }
}

async function runVerificationIfNeeded(opts: {
  batch: WikiWriteBatch;
  entry: WikiOutlineEntry;
  docId: string | undefined;
  wasCommitted: boolean;
  claims: import('./tools/contracts.js').WikiClaim[];
  languages: string;
  locale: 'zh' | 'en';
  workDir: string;
  sessionIds: string[];
  verifierHandle: ReturnType<typeof createVerifierTools>;
}): Promise<void> {
  const { batch, entry, docId, wasCommitted, claims, languages, locale, workDir, sessionIds, verifierHandle } = opts;
  if (!wasCommitted) return;

  const loadBearing = claims.filter(c => c.centrality === 'load-bearing');
  if (loadBearing.length === 0) {
    if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
    return;
  }

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

  assertCanStartAgentSessionProcess();
  const verifierSession = agentSessionRuntime.create({
    projectId: batch.projectId,
    profileId: 'wiki-verifier',
    prompt: verifierPrompt,
    sessionMetadata: { snapshotId: batch.snapshotId, phase: 'verifier', docTitle: entry.title },
  });
  sessionIds.push(verifierSession.id);
  setSessionWorkspaceRoot(verifierSession.id, workDir);

  await awaitAgentStream(verifierSession.id, locale, { softFail: true });

  const verdicts = verifierHandle.getVerdicts(verifierSession.id);
  verifierHandle.clearVerdicts(verifierSession.id);

  const refuted = verdicts.filter((v: WikiVerdict) => v.refuted);
  if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'verified');

  if (refuted.length > 0) {
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

    assertCanStartAgentSessionProcess();
    const correctorSession = agentSessionRuntime.create({
      projectId: batch.projectId,
      profileId: 'wiki-document-writer',
      prompt: correctorPrompt,
      sessionMetadata: {
        snapshotId: batch.snapshotId,
        phase: 'corrector',
        documentId: docId,
        docTitle: entry.title,
      },
    });
    sessionIds.push(correctorSession.id);
    setSessionWorkspaceRoot(correctorSession.id, workDir);
    await awaitAgentStream(correctorSession.id, locale, { softFail: true });
  }

  if (docId) await wikiStore.updateDocumentPipelineStage(docId, 'done');
}

export async function loadScanForBatch(workDir: string, projectId: string) {
  let gitState;
  try {
    gitState = await readGitState(workDir);
  } catch {
    gitState = fallbackGitState();
  }
  return acquireCodeMapScan({ projectId, workDir, gitState });
}

export async function loadOutlineForSnapshot(snapshotId: string): Promise<{
  outline: WikiOutlineEntry[];
  planIdToDocId: Map<string, string>;
}> {
  const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
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
  return { outline, planIdToDocId };
}
