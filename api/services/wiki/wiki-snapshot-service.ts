// ---------------------------------------------------------------------------
// api/services/wiki/wiki-snapshot-service.ts
//
// 首次生成 WikiSnapshot：Git 状态 + analyzer scan + Agent 生成 + 落库
// ---------------------------------------------------------------------------

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { wikiStore } from './wiki-store.js';
import { wikiAgentService } from './wiki-agent-service.js';
import { logger } from '../../lib/logger.js';
import { fallbackGitState } from './wiki-scan-cache.js';
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
  status: 'completed' | 'failed' | 'outline_ready' | 'writing';
  error?: string;
  docCount?: number;
}

const execAsync = promisify(exec);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export async function readGitState(workDir: string): Promise<WikiGitState> {
  const run = async (cmd: string): Promise<string> => {
    try {
      const { stdout } = await execAsync(cmd, { cwd: workDir, maxBuffer: GIT_MAX_BUFFER });
      return stdout.trim();
    } catch {
      return '';
    }
  };

  const [branchRaw, headCommitSha, statusOutput, diffOutput, cachedOutput] = await Promise.all([
    run('git rev-parse --abbrev-ref HEAD'),
    run('git rev-parse HEAD'),
    run('git status --porcelain'),
    run('git diff --binary'),
    run('git diff --cached --binary'),
  ]);

  const branch = branchRaw || 'unknown';
  const dirty = statusOutput.length > 0;

  const workingTreeHash = createHash('sha256')
    .update(statusOutput + diffOutput + cachedOutput)
    .digest('hex')
    .slice(0, 16);

  return {
    branch,
    headCommitSha: headCommitSha || '0000000000000000000000000000000000000000',
    workingTreeHash,
    dirty,
  };
}

export const wikiSnapshotService = {
  async generate(input: GenerateWikiInput): Promise<GenerateWikiResult> {
    const { projectId, locale = 'zh' } = input;

    const workDir = resolveWorkspaceRoot(input.workDir);

    let gitState: WikiGitState;
    try {
      gitState = await readGitState(workDir);
    } catch (err) {
      logger.warn({ err, workDir }, 'wiki: failed to read git state, using defaults');
      gitState = fallbackGitState();
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
