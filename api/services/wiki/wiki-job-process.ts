import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../lib/logger.js';
import { handleWikiJobChildMessage } from '../../lib/ipc/wiki-job-bridge.js';
import {
  handleWikiAgentChildMessage,
  cancelWikiAgentRequestsForChild,
} from '../../lib/ipc/wiki-agent-bridge.js';
import {
  isWikiAgentChildToParentMessage,
  isWikiJobChildMessage,
  type WikiJobPayload,
} from '../../lib/ipc/protocol.js';
import { runReinitialize } from './wiki-reinitialize-runner.js';
import { wikiLoopService } from './wiki-loop-service.js';

export type { WikiJobPayload } from '../../lib/ipc/protocol.js';

type ExitCallback = () => void;

function resolveWikiJobRunnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsRunner = path.resolve(here, '../../workers/wiki-job-runner.ts');
  if (fs.existsSync(tsRunner)) return tsRunner;
  return path.resolve(here, '../../../server-dist/workers/wiki-job-runner.cjs');
}

async function runWikiJobInProcess(job: WikiJobPayload): Promise<void> {
  if (job.kind === 'generate') {
    await wikiLoopService.generate({
      projectId: job.projectId,
      workDir: job.workDir,
      locale: job.locale,
    });
    return;
  }
  await runReinitialize({
    projectId: job.projectId,
    workDir: job.workDir,
    locale: job.locale,
  });
}

class WikiJobProcessManager {
  private child: ChildProcess | null = null;
  private activeProjectId: string | null = null;
  private onExitCallback: ExitCallback | null = null;

  isRunning(): boolean {
    return this.child != null || this.activeProjectId != null;
  }

  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  start(job: WikiJobPayload, onExit?: ExitCallback): boolean {
    if (this.isRunning()) {
      logger.warn({ projectId: job.projectId, activeProjectId: this.activeProjectId }, '[wiki-job] already running');
      return false;
    }

    if (process.env.SYNAX_WIKI_JOB_IN_PROCESS === '1') {
      this.activeProjectId = job.projectId;
      this.onExitCallback = onExit ?? null;
      void runWikiJobInProcess(job)
        .catch((err) => {
          logger.error({ err, projectId: job.projectId }, '[wiki-job] in-process job failed');
        })
        .finally(() => {
          this.activeProjectId = null;
          const cb = this.onExitCallback;
          this.onExitCallback = null;
          cb?.();
        });
      return true;
    }

    const runnerPath = resolveWikiJobRunnerPath();
    const isTs = runnerPath.endsWith('.ts');
    const child = fork(runnerPath, [], {
      env: {
        ...process.env,
        SYNAX_WIKI_JOB_CHILD: '1',
        WIKI_JOB_PAYLOAD: JSON.stringify(job),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: isTs ? ['--import', 'tsx/esm'] : [],
    });

    this.child = child;
    this.activeProjectId = job.projectId;
    this.onExitCallback = onExit ?? null;

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ chunk: chunk.toString().trimEnd() }, '[wiki-job] child stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn({ chunk: chunk.toString().trimEnd() }, '[wiki-job] child stderr');
    });

    child.on('message', (message: unknown) => {
      if (isWikiAgentChildToParentMessage(message)) {
        handleWikiAgentChildMessage(child, message);
        return;
      }
      if (!isWikiJobChildMessage(message)) return;
      handleWikiJobChildMessage(message);
    });

    child.on('exit', (code, signal) => {
      cancelWikiAgentRequestsForChild(child.pid);
      if (code !== 0) {
        logger.error({ code, signal, projectId: job.projectId }, '[wiki-job] child exited abnormally');
      }
      this.child = null;
      this.activeProjectId = null;
      const cb = this.onExitCallback;
      this.onExitCallback = null;
      cb?.();
    });

    logger.info({ projectId: job.projectId, kind: job.kind, pid: child.pid }, '[wiki-job] child started');
    return true;
  }
}

export const wikiJobProcess = new WikiJobProcessManager();
