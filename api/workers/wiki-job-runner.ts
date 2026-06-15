import { logger } from '../lib/logger.js';
import type { WikiJobPayload } from '../lib/ipc/protocol.js';
import { sendToParent } from '../lib/ipc/child-forward.js';
import { runReinitialize } from '../services/wiki/wiki-reinitialize-runner.js';
import { wikiLoopService } from '../services/wiki/wiki-loop-service.js';

async function main(): Promise<void> {
  const raw = process.env.WIKI_JOB_PAYLOAD;
  if (!raw) {
    logger.error('[wiki-job-runner] WIKI_JOB_PAYLOAD missing');
    process.exit(1);
    return;
  }

  let job: WikiJobPayload;
  try {
    job = JSON.parse(raw) as WikiJobPayload;
  } catch (err) {
    logger.error({ err }, '[wiki-job-runner] invalid WIKI_JOB_PAYLOAD');
    process.exit(1);
    return;
  }

  try {
    if (job.kind === 'generate') {
      await wikiLoopService.generate({
        projectId: job.projectId,
        workDir: job.workDir,
        locale: job.locale,
      });
    } else {
      await runReinitialize({
        projectId: job.projectId,
        workDir: job.workDir,
        locale: job.locale,
      });
    }
    sendToParent({ type: 'job:done', projectId: job.projectId });
    process.exit(0);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendToParent({ type: 'job:error', projectId: job.projectId, error });
    logger.error({ err, projectId: job.projectId }, '[wiki-job-runner] job failed');
    process.exit(1);
  }
}

void main();
