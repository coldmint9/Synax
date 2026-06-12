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

    const snapshot = await wikiStore.createSnapshot({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha,
      workingTreeHash: gitState.workingTreeHash,
      createdBy: 'system',
    });

    try {
      logger.info({ projectId, workDir }, 'wiki: running code map scan');
      const scan = await runCodeMapScan({
        projectId,
        workDir,
        include: ['all'],
      });

      await wikiStore.updateSnapshotStatus(snapshot.id, 'writing', []);
      logger.info({ projectId, snapshotId: snapshot.id }, 'wiki: calling generator agent');
      const agentOutput = await wikiAgentService.generateWiki(scan, { locale, projectId });

      const documentIds: string[] = [];

      for (const docDraft of agentOutput.documents) {
        const doc = await wikiStore.upsertDocument({
          snapshotId: snapshot.id,
          projectId,
          title: docDraft.title,
          docType: docDraft.docType,
          sortOrder: docDraft.sortOrder,
          contentMd: docDraft.markdown,
          references: docDraft.references,
        });
        documentIds.push(doc.id);
      }

      await wikiStore.updateSnapshotStatus(snapshot.id, 'ready', documentIds);
      logger.info({ projectId, snapshotId: snapshot.id, docCount: documentIds.length }, 'wiki: generation complete');

      return { snapshotId: snapshot.id, status: 'completed', docCount: documentIds.length };
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

export type { WikiSnapshot };
