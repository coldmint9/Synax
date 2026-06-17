import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { logger } from '../../../lib/logger.js';
import { ensureSynaxMd } from './synax-md.js';
import { resolveWikiLandscapeTitle } from './synax-runtime-context.js';

/** After a code-map scan: ensure SYNAX.md exists with commands, wiki pointer, packages. */
export function bootstrapSynaxFromScan(
  projectId: string,
  workDir: string,
  scan?: CodeMapScanResult,
): void {
  try {
    const wikiLandscapeTitle = resolveWikiLandscapeTitle(projectId);
    const result = ensureSynaxMd({ workDir, projectId, scan, wikiLandscapeTitle });
    if (result.created || result.updated) {
      logger.debug({ projectId, workDir, ...result }, '[synax] SYNAX.md bootstrapped from scan');
    }
  } catch (err) {
    logger.warn({ projectId, workDir, err }, '[synax] SYNAX.md bootstrap failed');
  }
}
