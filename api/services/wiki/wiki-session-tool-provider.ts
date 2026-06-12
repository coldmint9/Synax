import type { RegisteredTool, SessionToolProvider, ToolHook } from '../agent-runtime/contracts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { logger } from '../../lib/logger.js';
import { wikiStore } from './wiki-store.js';
import type { WikiDocumentDraft } from './tools/contracts.js';
import { buildCheckMermaidTool, buildCommitDocumentTool } from './tools/write-tools.js';

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

  getTools(sessionId: string): RegisteredTool[] {
    const session = agentRuntimeStore.getSession(sessionId);
    const meta = session.sessionMetadata;
    if (!meta?.snapshotId) return [];

    const phase = meta.phase as string | undefined;

    // For writer/document-writer/corrector: the global tool registry already
    // has wiki.commit_document and wiki.check_mermaid registered via
    // createWriterTools() before agent execution. The provider must NOT shadow
    // these global tools — the global tools share the committedDocuments array
    // with the afterExecute hook that persists blocks to DB. A fresh array inside
    // the provider would cause the hook to find no committed documents, silently
    // dropping all block content.
    //
    // Provider tools are only supplied for phases where global tools are absent
    // (e.g. explorer, verifier — which use different commit/verdict tools).

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

    // Commit hook: on resume, each wiki.commit_document call persists to DB
    const hookId = `wiki-resume-commit-${snapshotId}`;
    return [{
      id: hookId,
      toolId: 'wiki.commit_document',
      afterExecute: async (ctx) => {
        const result = ctx.result.result as {
          ok?: boolean; title?: string; docType?: string; index?: number;
        } | undefined;
        if (!result?.ok) return;

        try {
          const session = agentRuntimeStore.getSession(ctx.sessionId);
          const sid = (session.sessionMetadata as Record<string, unknown> | null)?.snapshotId as string | undefined;
          if (!sid) return;

          // Upsert document — find by title within snapshot, create if new
          const docs = await wikiStore.getDocumentsBySnapshot(sid);
          const existing = docs.find(d => d.title === (result.title ?? ''));

          if (!existing) {
            // Create a new document with empty blocks initially.
            // The actual block content is stored in the hook's result context
            // but for resume we keep it simple: just ensure the doc record exists.
            await wikiStore.upsertDocument({
              snapshotId: sid,
              projectId: session.projectId,
              title: result.title ?? 'Untitled',
              docType: (result.docType as WikiDocumentDraft['docType']) ?? 'module',
              parentId: null,
              sortOrder: 0,
              contentMd: '',
              references: [],
            });
            logger.info({ snapshotId: sid, title: result.title },
              '[wiki-session-tool-provider] created document on resume commit');
          }
        } catch (err) {
          logger.warn({ hookId, sessionId: ctx.sessionId, err },
            '[wiki-session-tool-provider] commit hook failed');
        }
      },
    }];
  }
}

export const wikiSessionToolProvider = new WikiSessionToolProvider();
