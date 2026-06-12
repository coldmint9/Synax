/**
 * Barrel re-export — all wiki tool logic lives in ./tools/.
 * This file exists for backward compatibility with existing imports.
 */
export {
  createPlannerTools,
  createWriterTools,
  createWikiTools,
  createWikiExplorerTools,
  buildReadTools,
  buildCheckMermaidTool,
  buildCommitDocumentTool,
  buildTreeString,
  WIKI_DOC_TYPES,
  MIN_CONTENT_LENGTH,
  MIN_MARKDOWN_LENGTH,
  PAGE_SIZE,
} from './tools/index.js';

export type {
  WikiDocumentDraft,
  WikiOutlineEntry,
  WikiPlanEntry,
  WikiPlannerHandle,
  WikiWriterHandle,
} from './tools/index.js';

export type { WikiToolsHandle } from './tools/index.js';
