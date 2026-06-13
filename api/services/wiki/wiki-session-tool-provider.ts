import type { RegisteredTool, SessionToolProvider, ToolHook } from '../agent-runtime/contracts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { logger } from '../../lib/logger.js';
import { persistWikiDocumentCommit, toCommitInput } from './wiki-commit-persistence.js';
import { wikiStore } from './wiki-store.js';
import type { WikiDocumentDraft } from './tools/contracts.js';
import { buildCheckMermaidTool, buildCommitDocumentTool } from './tools/write-tools.js';

const PROVIDER_ID = 'wiki-session-tools';
const WRITE_PHASES = new Set(['writer', 'document-writer', 'corrector']);

/**
 * Per-session tool instances so concurrent queue workers do not share commit state.
 */
class WikiSessionToolProvider implements SessionToolProvider {
  id = PROVIDER_ID;
  private readonly sessionTools = new Map<string, RegisteredTool[]>();
  private readonly sessionCommitted = new Map<string, WikiDocumentDraft[]>();

  getTools(sessionId: string): RegisteredTool[] {
    const cached = this.sessionTools.get(sessionId);
    if (cached) return cached;

    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session?.sessionMetadata?.snapshotId) return [];

    const phase = session.sessionMetadata.phase as string | undefined;
    if (!phase || !WRITE_PHASES.has(phase)) return [];

    const committedDocuments: WikiDocumentDraft[] = [];
    const tools = [
      buildCommitDocumentTool(committedDocuments, null),
      buildCheckMermaidTool(),
    ];
    this.sessionTools.set(sessionId, tools);
    this.sessionCommitted.set(sessionId, committedDocuments);
    return tools;
  }

  getCommittedDocuments(sessionId: string): WikiDocumentDraft[] {
    return this.sessionCommitted.get(sessionId) ?? [];
  }

  clearSessionTools(sessionId: string): void {
    this.sessionTools.delete(sessionId);
    this.sessionCommitted.delete(sessionId);
  }

  getHooks(sessionId: string): ToolHook[] {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session?.sessionMetadata?.snapshotId) return [];

    const phase = session.sessionMetadata.phase as string | undefined;
    if (!phase || !WRITE_PHASES.has(phase)) return [];

    const snapshotId = session.sessionMetadata.snapshotId as string;
    const hookId = `wiki-resume-commit-${snapshotId}-${sessionId}`;
    return [{
      id: hookId,
      toolId: 'wiki.commit_document',
      afterExecute: async (ctx) => {
        const commitResult = ctx.result.result as { ok?: boolean } | undefined;
        if (!commitResult?.ok) return;

        const draft = toCommitInput(ctx.args);
        if (!draft) return;

        try {
          const activeSession = agentRuntimeStore.getSession(ctx.sessionId);
          const sid = (activeSession.sessionMetadata as Record<string, unknown> | null)?.snapshotId as string | undefined;
          if (!sid) return;

          const committedDocId = await persistWikiDocumentCommit({
            draft,
            snapshotId: sid,
            projectId: activeSession.projectId,
            outline: null,
            planIdToDocId: new Map(),
          });
          await wikiStore.updateDocumentPipelineStage(committedDocId, 'drafted');
          logger.info({ snapshotId: sid, title: draft.title, docId: committedDocId },
            '[wiki-session-tool-provider] persisted document on commit');
        } catch (err) {
          logger.warn({ hookId, sessionId: ctx.sessionId, err },
            '[wiki-session-tool-provider] commit hook failed');
        }
      },
    }];
  }
}

export const wikiSessionToolProvider = new WikiSessionToolProvider();
