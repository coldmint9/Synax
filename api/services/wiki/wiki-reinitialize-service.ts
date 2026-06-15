import { beginProjectReinitialize, endProjectReinitialize } from './wiki-project-locks.js';
import { wikiJobProcess } from './wiki-job-process.js';

export interface ReinitializeWikiInput {
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
}

export function queueReinitialize(input: ReinitializeWikiInput): boolean {
  const { projectId } = input;
  if (!beginProjectReinitialize(projectId)) return false;

  const started = wikiJobProcess.start(
    {
      kind: 'reinitialize',
      projectId: input.projectId,
      workDir: input.workDir,
      locale: input.locale,
    },
    () => endProjectReinitialize(projectId),
  );

  if (!started) {
    endProjectReinitialize(projectId);
    return false;
  }

  return true;
}

export { runReinitialize } from './wiki-reinitialize-runner.js';
