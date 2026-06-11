// ---------------------------------------------------------------------------
// api/services/wiki/wiki-snapshot-service.ts
//
// 首次生成 WikiSnapshot：Git 状态 + analyzer scan + Agent 生成 + 落库
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { runCodeMapScan } from '../analyzer/scan.js';
import { resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js';
import { wikiStore } from './wiki-store.js';
import { wikiAgentService } from './wiki-agent-service.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { logger } from '../../lib/logger.js';
import type { WikiSnapshot } from './contracts.js';

export interface WikiGitState {
  branch: string;
  headCommitSha: string;
  workingTreeHash: string;
  dirty: boolean;
}

export interface GenerateWikiInput {
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
}

export interface GenerateWikiResult {
  snapshotId: string;
  status: 'completed' | 'failed' | 'outline_ready';
  error?: string;
  docCount?: number;
}

export function readGitState(workDir: string): WikiGitState {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };

  const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const headCommitSha = run('git rev-parse HEAD') || '0000000000000000000000000000000000000000';
  const statusOutput = run('git status --porcelain');
  const diffOutput = run('git diff --binary');
  const cachedOutput = run('git diff --cached --binary');
  const dirty = statusOutput.length > 0;

  const workingTreeHash = createHash('sha256')
    .update(statusOutput + diffOutput + cachedOutput)
    .digest('hex')
    .slice(0, 16);

  return { branch, headCommitSha, workingTreeHash, dirty };
}

export const wikiSnapshotService = {
  async generate(input: GenerateWikiInput): Promise<GenerateWikiResult> {
    const { projectId, locale = 'zh' } = input;

    const workDir = resolveWorkspaceRoot(input.workDir);

    // 1. Read git state
    let gitState: WikiGitState;
    try {
      gitState = readGitState(workDir);
    } catch (err) {
      logger.warn({ err, workDir }, 'wiki: failed to read git state, using defaults');
      gitState = {
        branch: 'unknown',
        headCommitSha: '0000000000000000000000000000000000000000',
        workingTreeHash: nanoid(16),
        dirty: false,
      };
    }

    // 2. Create snapshot in 'refreshing' state
    const snapshot = await wikiStore.createSnapshot({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha,
      workingTreeHash: gitState.workingTreeHash,
      createdBy: 'agent',
    });

    await wikiStore.updateSnapshotStatus(snapshot.id, 'refreshing');

    try {
      // 3. Run analyzer scan
      logger.info({ projectId, workDir }, 'wiki: running code map scan');
      const scan = await runCodeMapScan({
        projectId,
        workDir,
        include: ['all'],
      });

      const repoIndexId = scan.scanId;

      // 4. Call Wiki Generator Agent
      logger.info({ projectId, snapshotId: snapshot.id }, 'wiki: calling generator agent');
      const agentOutput = await wikiAgentService.generateWiki(scan, { locale, projectId });

      // 5. Persist documents + blocks
      const documentIds: string[] = [];

      for (const docDraft of agentOutput.documents) {
        const doc = await wikiStore.upsertDocument({
          snapshotId: snapshot.id,
          projectId,
          title: docDraft.title,
          docType: docDraft.docType,
          sortOrder: docDraft.sortOrder,
          blockIds: [],
        });

        const blockIds: string[] = [];
        const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

        for (const blockDraft of docDraft.blocks) {
          const block = await wikiStore.upsertBlock({
            projectId,
            documentId: doc.id,
            blockType: blockDraft.blockType,
            content: blockDraft.content,
            contentFormat: blockDraft.contentFormat ?? (typeof blockDraft.content === 'object' && blockDraft.content !== null ? 'structured_json' : 'markdown_fragment'),
            confidence: blockDraft.confidence ?? 0.5,
            generatedBy: { agentRunId: snapshot.id, model: 'wiki-generator' },
          });
          blockIds.push(block.id);

          // Map sourceHints → synthetic SourceLinks using codeIndex
          const sourceHints = blockDraft.sourceHints ?? [];
          if (sourceHints.length > 0) {
            const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
            if (links.length > 0) {
              blockLinkMap.push({ blockId: block.id, links });
            }
          }
        }

        // Update document with block order
        await wikiStore.updateDocumentBlockIds(doc.id, blockIds);

        // Create source bindings
        if (blockLinkMap.length > 0) {
          await wikiCoordinateService.createBindingsFromLinks(
            projectId,
            repoIndexId,
            blockLinkMap,
            scan.codeIndex,
          );
        }

        documentIds.push(doc.id);
      }

      // 6. Mark snapshot ready
      await wikiStore.updateSnapshotStatus(snapshot.id, 'ready', documentIds);
      logger.info({ projectId, snapshotId: snapshot.id, docCount: documentIds.length }, 'wiki: generation complete');

      return { snapshotId: snapshot.id, status: 'completed' };
    } catch (err) {
      logger.error({ err, projectId, snapshotId: snapshot.id }, 'wiki: generation failed');
      await wikiStore.updateSnapshotStatus(snapshot.id, 'failed');
      return {
        snapshotId: snapshot.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveSourceHints(
  hints: string[],
  codeIndex: import('../contracts/code-map.js').CodeMapCodeIndex,
  blockId: string,
): import('../contracts/forest.js').SourceLink[] {
  const links: import('../contracts/forest.js').SourceLink[] = [];

  for (const hint of hints) {
    // Try symbol match first
    const sym = codeIndex.symbols.find(
      s => s.qualifiedName === hint || s.name === hint,
    );
    if (sym) {
      links.push({
        id: nanoid(),
        nodeId: blockId,
        anchor: { kind: 'symbol', symbolId: sym.id },
        confidence: 0.8,
        createdBy: 'analyzer',
      });
      continue;
    }

    // Try file path match
    const file = codeIndex.files.find(
      f => f.path === hint || f.path.endsWith(hint),
    );
    if (file) {
      links.push({
        id: nanoid(),
        nodeId: blockId,
        anchor: { kind: 'file', fileId: file.id },
        confidence: 0.6,
        createdBy: 'analyzer',
      });
    }
  }

  return links;
}
