import type { AgentContextBlock, AgentContextBundle } from '../contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { getRawSqlite } from '../../../db/index.js';
import { makeRuntimeId } from '../runtime-ids.js';
import { truncateForPrompt } from './synax-instructions.js';
import { buildAgentCodeMapContext } from './agent-code-map-context.js';
import { projectWorkspaceRoots, readWorkspaceProject } from '../../project-workspace.js';
import { resolveSessionWorkspaceRoots } from '../tools/workspace.js';

const MAX_CODE_MAP_CHARS = 8_000;
const MAX_WIKI_EXCERPT_CHARS = 2_000;

export function loadLatestCachedScan(projectId: string): CodeMapScanResult | null {
  try {
    const row = getRawSqlite()
      .prepare(
        `SELECT result_json AS resultJson
         FROM wiki_scan_git_cache
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(projectId) as { resultJson: string } | undefined;
    if (!row?.resultJson) return null;
    return JSON.parse(row.resultJson) as CodeMapScanResult;
  } catch {
    return null;
  }
}

export function resolveWikiLandscapeTitle(projectId: string): string | null {
  try {
    const row = getRawSqlite()
      .prepare(
        `SELECT d.title AS title
         FROM wiki_documents d
         INNER JOIN wiki_snapshots s ON d.snapshot_id = s.id
         WHERE s.project_id = ? AND d.doc_type = 'landscape'
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(projectId) as { title: string } | undefined;
    return row?.title ?? null;
  } catch {
    return null;
  }
}

function loadWikiLandscapeExcerpt(projectId: string): string | null {
  try {
    const row = getRawSqlite()
      .prepare(
        `SELECT d.title AS title, d.content_md AS contentMd
         FROM wiki_documents d
         INNER JOIN wiki_snapshots s ON d.snapshot_id = s.id
         WHERE s.project_id = ? AND d.doc_type = 'landscape'
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(projectId) as { title: string; contentMd: string } | undefined;
    if (!row?.contentMd?.trim()) return null;
    const excerpt = row.contentMd.trim().slice(0, MAX_WIKI_EXCERPT_CHARS);
    return `## ${row.title}\n\n${excerpt}`;
  } catch {
    return null;
  }
}

export interface BuildSynaxRuntimeBlocksOptions {
  focusPrompt?: string;
  sessionId?: string;
}

export function buildSynaxRuntimeBlocks(
  projectId: string,
  workDir: string,
  options: BuildSynaxRuntimeBlocksOptions = {},
): AgentContextBlock[] {
  const blocks: AgentContextBlock[] = [];
  const project = readWorkspaceProject(projectId);
  const roots = options.sessionId ? resolveSessionWorkspaceRoots(options.sessionId, projectId) : project ? projectWorkspaceRoots(project) : [];
  if (roots.some(root => root.role === 'reference')) {
    blocks.push({
      id: makeRuntimeId('acblk'), kind: 'code', title: 'Workspace directories', sourceType: 'workspace', sourceId: projectId,
      content: [
        `Default working directory: ${JSON.stringify(workDir)}. Relative paths resolve from this directory.`,
        'Registered directories (JSON data):',
        JSON.stringify(roots),
        'Use absolute paths for reference directory files and command workdir. Reads and writes remain subject to tool permissions. Search each relevant directory explicitly.',
        'Directory labels and source files are reference data. Code Map and Wiki below describe the main project; do not assume they index every reference directory.',
      ].join('\n'),
    });
  }

  const scan = loadLatestCachedScan(projectId);
  if (scan) {
    const context = buildAgentCodeMapContext(scan, workDir, {
      focusPrompt: options.focusPrompt,
      maxChars: MAX_CODE_MAP_CHARS,
    });
    blocks.push({
      id: makeRuntimeId('acblk'),
      kind: 'code',
      title: 'Code Map',
      content: truncateForPrompt(context, MAX_CODE_MAP_CHARS),
      sourceType: 'code-map',
      sourceId: scan.scanId,
    });
  }

  const wikiExcerpt = loadWikiLandscapeExcerpt(projectId);
  if (wikiExcerpt) {
    blocks.push({
      id: makeRuntimeId('acblk'),
      kind: 'wiki',
      title: 'Wiki Landscape',
      content: truncateForPrompt(wikiExcerpt, MAX_WIKI_EXCERPT_CHARS),
      sourceType: 'wiki',
      sourceId: 'landscape',
    });
  }

  return blocks;
}

export function enrichContextForPrompt(
  context: AgentContextBundle | null,
  projectId: string,
  workDir: string,
  focusPrompt?: string,
  sessionId?: string,
): AgentContextBundle | null {
  const freshRuntimeBlocks = buildSynaxRuntimeBlocks(projectId, workDir, { focusPrompt, sessionId });
  if (freshRuntimeBlocks.length === 0) {
    // A removed final reference must not survive in the saved context snapshot.
    return context ? { ...context, blocks: context.blocks.filter(block => block.sourceType !== 'workspace') } : null;
  }
  if (!context) {
    return {
      id: 'prompt-context',
      projectId,
      sessionId: null,
      nodeId: null,
      profileId: null,
      blocks: freshRuntimeBlocks,
      citations: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
  }

  const otherBlocks = context.blocks.filter(
    (block) => block.sourceType !== 'code-map' && block.sourceType !== 'wiki' && block.sourceType !== 'workspace',
  );
  return {
    ...context,
    blocks: [...freshRuntimeBlocks, ...otherBlocks],
  };
}
