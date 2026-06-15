import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiLoopService } from './wiki-loop-service.js';
import { publishLatestWikiSnapshot, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import { wikiStore } from './wiki-store.js';
import type { ReinitializeWikiInput } from './wiki-reinitialize-service.js';

export async function runReinitialize(input: ReinitializeWikiInput): Promise<void> {
  const { projectId, workDir, locale = 'zh' } = input;

  try {
    await wikiStore.purgeProject(projectId);
    await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.ProjectPurged);
    await wikiLoopService.generate({ projectId, workDir, locale });
  } catch (err) {
    logger.error({ err, projectId }, '[wiki] reinitialize background task failed');
    notify({
      type: TaskNotificationEventType.TaskFailed,
      taskKind: 'wiki_generate',
      projectId,
      taskId: projectId,
      title: locale === 'en' ? 'Wiki Reinitialize' : 'Wiki 重新初始化',
      message: err instanceof Error ? err.message : 'Wiki reinitialize failed',
      severity: 'error',
    });
  }
}
