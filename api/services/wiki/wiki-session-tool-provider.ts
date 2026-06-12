import type { SessionToolProvider, ToolHook } from '../agent-runtime/contracts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { logger } from '../../lib/logger.js';
import { persistWikiDocumentCommit, toCommitInput } from './wiki-commit-persistence.js';
import { wikiStore } from './wiki-store.js';

const PROVIDER_ID = 'wiki-session-tools';

/**
 * SessionToolProvider that ensures wiki-specific tools (wiki.commit_document,
 * wiki.check_mermaid, etc.) are available when a wiki session is resumed.
 *
 * On resume after pause/interrupt/server-restart, the global toolRegistry
 * may have lost wiki tools that were temporarily registered during generation.
 * This provider reconstructs the essential write tools with fresh session state.
 *
 * Read tools (wiki.read_code_index, etc.) are NOT reconstructed here because
 * the wiki profiles' allowedCapabilities include bash + file tools which cover
 * the same needs on resume. Only the unique commit/check/verdict tools are
 * provider-supplied since they have no built-in equivalent.
 */
class WikiSessionToolProvider implements SessionToolProvider {
  id = PROVIDER_ID;

  getTools(_sessionId: string): [] {
    // Writer/document-writer/corrector phases rely on globally registered wiki tools.
    // Provider tools must not shadow them or split committedDocuments state.
    return [];
  }

  getHooks(sessionId: string): ToolHook[] {
    const session = agentRuntimeStore.getSession(sessionId);
    const meta = session.sessionMetadata;
    if (!meta?.snapshotId) return [];

    const snapshotId = meta.snapshotId as string;
    const phase = meta.phase as string | undefined;

    if (phase !== 'writer' && phase !== 'document-writer' && phase !== 'corrector') {
      return [];
    }

    const hookId = `wiki-resume-commit-${snapshotId}`;
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
            '[wiki-session-tool-provider] persisted document on resume commit');
        } catch (err) {
          logger.warn({ hookId, sessionId: ctx.sessionId, err },
            '[wiki-session-tool-provider] commit hook failed');
        }
      },
    }];
  }
}

export const wikiSessionToolProvider = new WikiSessionToolProvider();
