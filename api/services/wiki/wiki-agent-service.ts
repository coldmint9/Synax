// ---------------------------------------------------------------------------
// api/services/wiki/wiki-agent-service.ts
//
// Wiki Generator Agent — 调用 LLM 生成结构化 WikiDocument/WikiBlock 草稿
// ---------------------------------------------------------------------------

import { NoObjectGeneratedError } from 'ai';
import { nanoid } from 'nanoid';
import * as z from 'zod/v4';
import { generateGatewayObject } from '../llm-runtime/gateway.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { logger } from '../../lib/logger.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import type { WikiBlockContentFormat, WikiDocType, WikiBlockType } from './contracts.js';

// ── Output schema ────────────────────────────────────────────────────────────

const WikiBlockDraftSchema = z.object({
  id: z.string(),
  blockType: z.enum(['heading', 'paragraph', 'list', 'table', 'diagram', 'code_ref', 'task']),
  content: z.unknown(),
  contentFormat: z.enum(['rich_text_json', 'markdown_fragment', 'diagram_json']).optional(),
  sourceHints: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const WikiDocumentDraftSchema = z.object({
  id: z.string(),
  title: z.string(),
  docType: z.enum(['overview', 'architecture', 'tech_stack', 'module_design', 'data_model', 'api', 'flow', 'directory_tree', 'module_spec']),
  sortOrder: z.number().optional(),
  blocks: z.array(WikiBlockDraftSchema),
});

const WikiGeneratorOutputSchema = z.object({
  documents: z.array(WikiDocumentDraftSchema),
});

const RawWikiBlockDraftSchema = z.object({
  id: z.string().optional(),
  blockType: z.string().optional(),
  content: z.unknown().optional(),
  contentFormat: z.string().optional(),
  sourceHints: z.union([z.array(z.string()), z.string()]).optional(),
  confidence: z.union([z.number(), z.string()]).optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
}).passthrough();

const RawWikiDocumentDraftSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  docType: z.string().optional(),
  sortOrder: z.union([z.number(), z.string()]).optional(),
  blocks: z.array(RawWikiBlockDraftSchema).optional(),
  sections: z.array(RawWikiBlockDraftSchema).optional(),
  content: z.union([z.array(RawWikiBlockDraftSchema), z.string()]).optional(),
  summary: z.string().optional(),
}).passthrough();

const RawWikiGeneratorOutputSchema = z.object({
  documents: z.array(RawWikiDocumentDraftSchema).optional(),
  docs: z.array(RawWikiDocumentDraftSchema).optional(),
  sections: z.array(RawWikiDocumentDraftSchema).optional(),
}).passthrough();

export type WikiBlockDraft = z.infer<typeof WikiBlockDraftSchema>;
export type WikiDocumentDraft = z.infer<typeof WikiDocumentDraftSchema>;
export type WikiGeneratorOutput = z.infer<typeof WikiGeneratorOutputSchema>;
type RawWikiBlockDraft = z.infer<typeof RawWikiBlockDraftSchema>;
type RawWikiDocumentDraft = z.infer<typeof RawWikiDocumentDraftSchema>;
type RawWikiGeneratorOutput = z.infer<typeof RawWikiGeneratorOutputSchema>;

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a senior software architect generating a structured Codebase Design Wiki.
Rules:
- Allowed docType values: overview, architecture, tech_stack, module_design, data_model, api, flow, directory_tree, module_spec.
- Allowed blockType values: heading, paragraph, list, table, diagram, code_ref, task.
- Do not generate document ids or block ids. The system will assign them.
- Every non-heading block must have at least one sourceHint (file path, symbol name, or module name from the code index).
- Blocks without evidence must have confidence < 0.5.
- Keep blocks focused and atomic — one concept per block.
- Do not invent APIs, types, or modules that are not in the code index.
- Output only valid json matching the schema exactly.`;
}

function buildUserPrompt(scan: CodeMapScanResult): string {
  const { codeIndex, semanticGraph, moduleMap, communities } = scan;

  const fileSummary = codeIndex.files
    .slice(0, 60)
    .map(f => `${f.path} (${f.language})`)
    .join('\n');

  const symbolSummary = codeIndex.symbols
    .slice(0, 80)
    .map(s => `${s.qualifiedName} [${s.kind}]`)
    .join('\n');

  const moduleSummary = moduleMap?.topDirs
    .slice(0, 20)
    .map(m => `${m.path}: ${m.fileCount} files, ${m.symbolCount} symbols`)
    .join('\n') ?? '';

  const communitySummary = communities
    ?.slice(0, 10)
    .map(c => `${c.label}: ${c.summary} (${c.fileCount} files)`)
    .join('\n') ?? '';

  const semanticNodes = semanticGraph.nodes
    .slice(0, 20)
    .map(n => `${n.label} [${n.kind}]: ${n.summary ?? ''}`)
    .join('\n');

  return `Generate a Codebase Design Wiki for this project.

## Files (${codeIndex.files.length} total, showing first 60)
${fileSummary}

## Key Symbols (${codeIndex.symbols.length} total, showing first 80)
${symbolSummary}

## Module Structure
${moduleSummary}

## Semantic Communities
${communitySummary}

## Semantic Graph Nodes
${semanticNodes}

Generate documents covering: overview, architecture, tech_stack, and the most important module_design sections.
Each document should have 3-8 blocks. Use sourceHints to reference actual file paths and symbol names from above.
Return only valid json. Do not include markdown fences or explanatory prose.`;
}

// ── Normalization ────────────────────────────────────────────────────────────

const DOC_TYPE_VALUES = new Set<WikiDocType>([
  'overview',
  'architecture',
  'tech_stack',
  'module_design',
  'data_model',
  'api',
  'flow',
]);

const BLOCK_TYPE_VALUES = new Set<WikiBlockType>([
  'heading',
  'paragraph',
  'list',
  'table',
  'diagram',
  'code_ref',
  'task',
]);

const CONTENT_FORMAT_VALUES = new Set<WikiBlockContentFormat>([
  'rich_text_json',
  'markdown_fragment',
  'diagram_json',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => stringifyUnknown(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  const record = asRecord(value);
  if (record) {
    const preferred = firstString(
      record.text,
      record.title,
      record.summary,
      record.description,
      record.decision,
      record.rationale,
      record.code,
      record.content,
    );
    if (preferred) return preferred;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampConfidence(value: unknown): number | undefined {
  const numeric = coerceNumber(value);
  if (numeric == null) return undefined;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeSourceHints(value: unknown, fallbackContent: unknown): string[] | undefined {
  const hints: string[] = [];

  if (typeof value === 'string' && value.trim().length > 0) {
    hints.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim().length > 0) {
        hints.push(item.trim());
      }
    }
  }

  const content = asRecord(fallbackContent);
  const filePath = firstString(content?.filePath, content?.path);
  if (filePath) hints.push(filePath);
  const qualifiedName = firstString(content?.qualifiedName, content?.symbolName);
  if (qualifiedName) hints.push(qualifiedName);

  const unique = [...new Set(hints)];
  return unique.length > 0 ? unique : undefined;
}

function normalizeDocType(value: unknown, title: string | undefined): WikiDocType {
  if (typeof value === 'string') {
    const normalized = normalizeKey(value);
    if (DOC_TYPE_VALUES.has(normalized as WikiDocType)) {
      return normalized as WikiDocType;
    }
    if (normalized.includes('tech') && normalized.includes('stack')) return 'tech_stack';
    if (normalized.includes('module')) return 'module_design';
    if (normalized.includes('data') && normalized.includes('model')) return 'data_model';
    if (normalized === 'api' || normalized.includes('interface') || normalized.includes('endpoint')) return 'api';
    if (normalized.includes('flow') || normalized.includes('workflow')) return 'flow';
    if (normalized.includes('arch')) return 'architecture';
    if (normalized.includes('overview') || normalized.includes('summary')) return 'overview';
  }

  const titleKey = normalizeKey(title ?? '');
  if (titleKey.includes('tech') && titleKey.includes('stack')) return 'tech_stack';
  if (titleKey.includes('module')) return 'module_design';
  if (titleKey.includes('data') && titleKey.includes('model')) return 'data_model';
  if (titleKey === 'api' || titleKey.includes('endpoint')) return 'api';
  if (titleKey.includes('flow')) return 'flow';
  if (titleKey.includes('arch')) return 'architecture';
  return 'overview';
}

function normalizeBlockType(raw: RawWikiBlockDraft): WikiBlockType {
  if (typeof raw.blockType === 'string') {
    const normalized = normalizeKey(raw.blockType);
    if (BLOCK_TYPE_VALUES.has(normalized as WikiBlockType)) {
      return normalized as WikiBlockType;
    }
    if (normalized.includes('heading') || normalized === 'title') return 'heading';
    if (normalized === 'text' || normalized === 'summary' || normalized === 'note') return 'paragraph';
    if (normalized.includes('list') || normalized === 'bullets' || normalized === 'checklist') return 'list';
    if (normalized.includes('table') || normalized === 'matrix') return 'table';
    if (normalized.includes('diagram') || normalized === 'mermaid' || normalized === 'graph') return 'diagram';
    if (normalized.includes('code')) return 'code_ref';
    if (normalized.includes('task') || normalized.includes('todo')) return 'task';
  }

  const content = asRecord(raw.content);
  if (Array.isArray(raw.items) || Array.isArray(content?.items)) return 'list';
  if (Array.isArray(content?.headers) || Array.isArray(content?.rows)) return 'table';
  if (firstString(content?.code, content?.filePath, content?.qualifiedName)) return 'code_ref';
  if (firstString(raw.title) && coerceNumber(content?.level ?? asRecord(raw)?.level) != null) return 'heading';
  return 'paragraph';
}

function normalizeHeadingContent(raw: RawWikiBlockDraft): { level: number; text: string } {
  const content = asRecord(raw.content);
  const level = Math.max(1, Math.min(6, Math.trunc(coerceNumber(content?.level ?? asRecord(raw)?.level) ?? 2)));
  const text = firstString(raw.text, raw.title, content?.text, content?.title, raw.content) ?? 'Section';
  return { level, text };
}

function normalizeListContent(raw: RawWikiBlockDraft): { items: string[]; ordered: boolean } | null {
  const content = asRecord(raw.content);
  const rawItems = Array.isArray(raw.content)
    ? raw.content
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(content?.items)
        ? content.items
        : null;
  const items = (rawItems ?? [])
    .map(item => stringifyUnknown(item))
    .map(item => item.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean);

  if (items.length === 0 && typeof raw.content === 'string') {
    const splitItems = raw.content
      .split('\n')
      .map(item => item.replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean);
    if (splitItems.length > 0) {
      return { items: splitItems, ordered: false };
    }
  }

  if (items.length === 0) return null;
  const ordered = Boolean(content?.ordered ?? asRecord(raw)?.ordered);
  return { items, ordered };
}

function normalizeTableContent(raw: RawWikiBlockDraft): { headers: string[]; rows: string[][] } | null {
  const content = asRecord(raw.content);
  const headers = Array.isArray(content?.headers)
    ? content.headers.map(item => stringifyUnknown(item)).filter(Boolean)
    : [];
  const rows = Array.isArray(content?.rows)
    ? content.rows
      .filter(Array.isArray)
      .map(row => row.map(cell => stringifyUnknown(cell)))
      .filter(row => row.length > 0)
    : [];
  if (headers.length === 0) return null;
  return { headers, rows };
}

function normalizeCodeRefContent(raw: RawWikiBlockDraft): Record<string, unknown> {
  const content = asRecord(raw.content);
  const code = firstString(content?.code, raw.content, raw.text) ?? '';
  const normalized: Record<string, unknown> = { code };
  const language = firstString(content?.language);
  if (language) normalized.language = language;
  const filePath = firstString(content?.filePath, content?.path);
  if (filePath) normalized.filePath = filePath;
  const range = asRecord(content?.range);
  const startLine = coerceNumber(range?.startLine);
  const endLine = coerceNumber(range?.endLine);
  if (startLine != null && endLine != null) {
    normalized.range = { startLine, endLine };
  }
  return normalized;
}

function normalizeBlock(raw: RawWikiBlockDraft): WikiBlockDraft {
  const blockType = normalizeBlockType(raw);
  const sourceHints = normalizeSourceHints(raw.sourceHints, raw.content);
  const confidence = clampConfidence(raw.confidence);

  if (blockType === 'heading') {
    return {
      id: nanoid(),
      blockType,
      content: normalizeHeadingContent(raw),
      contentFormat: 'rich_text_json',
      ...(sourceHints ? { sourceHints } : {}),
      ...(confidence != null ? { confidence } : {}),
    };
  }

  if (blockType === 'list') {
    const content = normalizeListContent(raw);
    if (content) {
      return {
        id: nanoid(),
        blockType,
        content,
        contentFormat: 'rich_text_json',
        ...(sourceHints ? { sourceHints } : {}),
        ...(confidence != null ? { confidence } : {}),
      };
    }
  }

  if (blockType === 'table') {
    const content = normalizeTableContent(raw);
    if (content) {
      return {
        id: nanoid(),
        blockType,
        content,
        contentFormat: 'rich_text_json',
        ...(sourceHints ? { sourceHints } : {}),
        ...(confidence != null ? { confidence } : {}),
      };
    }
  }

  if (blockType === 'code_ref') {
    return {
      id: nanoid(),
      blockType,
      content: normalizeCodeRefContent(raw),
      contentFormat: 'rich_text_json',
      ...(sourceHints ? { sourceHints } : {}),
      ...(confidence != null ? { confidence } : {}),
    };
  }

  if (blockType === 'diagram') {
    const preferredFormat = typeof raw.contentFormat === 'string' && CONTENT_FORMAT_VALUES.has(raw.contentFormat as WikiBlockContentFormat)
      ? raw.contentFormat as WikiBlockContentFormat
      : undefined;
    const stringContent = stringifyUnknown(raw.content);
    const contentFormat = preferredFormat ?? (typeof raw.content === 'string' ? 'markdown_fragment' : 'diagram_json');
    return {
      id: nanoid(),
      blockType,
      content: contentFormat === 'diagram_json' ? (raw.content ?? {}) : stringContent,
      contentFormat,
      ...(sourceHints ? { sourceHints } : {}),
      ...(confidence != null ? { confidence } : {}),
    };
  }

  if (blockType === 'task') {
    const text = firstString(raw.text, raw.title, raw.content) ?? stringifyUnknown(raw.content);
    return {
      id: nanoid(),
      blockType,
      content: text,
      contentFormat: 'markdown_fragment',
      ...(sourceHints ? { sourceHints } : {}),
      ...(confidence != null ? { confidence } : {}),
    };
  }

  return {
    id: nanoid(),
    blockType: 'paragraph',
    content: {
      text: firstString(raw.text, raw.title, raw.content) ?? stringifyUnknown(raw.content),
    },
    contentFormat: 'rich_text_json',
    ...(sourceHints ? { sourceHints } : {}),
    ...(confidence != null ? { confidence } : {}),
  };
}

function toRawBlockArray(value: unknown): RawWikiBlockDraft[] {
  if (Array.isArray(value)) {
    return value
      .map(item => RawWikiBlockDraftSchema.safeParse(item))
      .filter(result => result.success)
      .map(result => result.data);
  }
  return [];
}

function normalizeDocumentTitle(raw: RawWikiDocumentDraft, docType: WikiDocType, locale: 'zh' | 'en'): string {
  const explicitTitle = firstString(raw.title, raw.summary);
  if (explicitTitle) return explicitTitle;

  const fallbackTitles: Record<WikiDocType, { zh: string; en: string }> = {
    overview: { zh: '项目概览', en: 'Overview' },
    architecture: { zh: '架构设计', en: 'Architecture' },
    tech_stack: { zh: '技术栈', en: 'Tech Stack' },
    module_design: { zh: '模块设计', en: 'Module Design' },
    data_model: { zh: '数据模型', en: 'Data Model' },
    api: { zh: 'API 设计', en: 'API Design' },
    flow: { zh: '流程设计', en: 'Flow' },
    directory_tree: { zh: '目录结构', en: 'Directory Tree' },
    module_spec: { zh: '模块规格', en: 'Module Spec' },
  };

  return fallbackTitles[docType][locale];
}

function normalizeDocument(raw: RawWikiDocumentDraft, index: number, locale: 'zh' | 'en'): WikiDocumentDraft {
  const rawBlocks = raw.blocks
    ?? raw.sections
    ?? (Array.isArray(raw.content) ? raw.content : undefined)
    ?? toRawBlockArray(asRecord(raw)?.body);

  const docType = normalizeDocType(raw.docType, raw.title);
  const blocks = rawBlocks.map(normalizeBlock);

  if (blocks.length === 0) {
    const fallbackText = firstString(raw.summary, raw.content);
    if (fallbackText) {
      blocks.push(normalizeBlock({ blockType: 'paragraph', content: fallbackText }));
    }
  }

  return {
    id: nanoid(),
    title: normalizeDocumentTitle(raw, docType, locale),
    docType,
    sortOrder: coerceNumber(raw.sortOrder) ?? index,
    blocks,
  };
}

function getRawDocuments(raw: RawWikiGeneratorOutput): RawWikiDocumentDraft[] {
  return raw.documents ?? raw.docs ?? raw.sections ?? [];
}

function normalizeGeneratedWiki(raw: RawWikiGeneratorOutput, locale: 'zh' | 'en'): WikiGeneratorOutput {
  const documents = getRawDocuments(raw)
    .map((doc, index) => normalizeDocument(doc, index, locale))
    .filter(doc => doc.blocks.length > 0);

  return WikiGeneratorOutputSchema.parse({ documents });
}

function parseRawWikiOutputText(text: string): RawWikiGeneratorOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const direct = RawWikiGeneratorOutputSchema.safeParse(parsed);
  if (direct.success) return direct.data;

  if (Array.isArray(parsed)) {
    const wrapped = RawWikiGeneratorOutputSchema.safeParse({ documents: parsed });
    return wrapped.success ? wrapped.data : null;
  }

  const record = asRecord(parsed);
  if (!record) return null;

  for (const key of ['wiki', 'result', 'output', 'data']) {
    const nested = RawWikiGeneratorOutputSchema.safeParse(record[key]);
    if (nested.success) return nested.data;
  }

  for (const key of ['documents', 'docs', 'sections']) {
    if (Array.isArray(record[key])) {
      const wrapped = RawWikiGeneratorOutputSchema.safeParse({ documents: record[key] });
      if (wrapped.success) return wrapped.data;
    }
  }

  return null;
}

function buildFallbackWiki(scan: CodeMapScanResult, locale: 'zh' | 'en'): WikiGeneratorOutput {
  const topFiles = scan.codeIndex.files.slice(0, 5).map(file => file.path);
  const topSourceHints = topFiles.slice(0, 3);
  const languageCounts = new Map<string, number>();
  for (const file of scan.codeIndex.files) {
    languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1);
  }

  const languageItems = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, count]) => `${language}: ${count} files`);

  const moduleItems = (scan.moduleMap?.topDirs ?? [])
    .slice(0, 6)
    .map(module => `${module.path}: ${module.fileCount} files, ${module.symbolCount} symbols`);

  const communityItems = (scan.communities ?? [])
    .slice(0, 6)
    .map(community => `${community.label}: ${community.summary}`);

  const overviewText = locale === 'zh'
    ? `分析器当前索引到 ${scan.codeIndex.files.length} 个文件和 ${scan.codeIndex.symbols.length} 个符号。由于模型结构化输出未通过校验，此版本 Wiki 使用静态分析结果自动生成。`
    : `The analyzer indexed ${scan.codeIndex.files.length} files and ${scan.codeIndex.symbols.length} symbols. The model response did not pass structured validation, so this wiki snapshot was generated from static analysis data.`;

  const architectureText = locale === 'zh'
    ? '以下结构来自模块聚类和语义社区摘要，可作为后续人工完善的初始骨架。'
    : 'The structure below comes from module clustering and semantic community summaries and should be treated as a starting point for refinement.';

  return WikiGeneratorOutputSchema.parse({
    documents: [
      {
        id: nanoid(),
        title: locale === 'zh' ? '项目概览' : 'Overview',
        docType: 'overview',
        sortOrder: 0,
        blocks: [
          {
            id: nanoid(),
            blockType: 'paragraph',
            content: { text: overviewText },
            contentFormat: 'rich_text_json',
            sourceHints: topSourceHints,
            confidence: 0.6,
          },
          {
            id: nanoid(),
            blockType: 'list',
            content: { items: topFiles, ordered: false },
            contentFormat: 'rich_text_json',
            sourceHints: topSourceHints,
            confidence: 0.6,
          },
        ],
      },
      {
        id: nanoid(),
        title: locale === 'zh' ? '架构设计' : 'Architecture',
        docType: 'architecture',
        sortOrder: 1,
        blocks: [
          {
            id: nanoid(),
            blockType: 'paragraph',
            content: { text: architectureText },
            contentFormat: 'rich_text_json',
            sourceHints: topSourceHints,
            confidence: 0.55,
          },
          {
            id: nanoid(),
            blockType: 'list',
            content: { items: moduleItems.length > 0 ? moduleItems : communityItems, ordered: false },
            contentFormat: 'rich_text_json',
            sourceHints: topSourceHints,
            confidence: 0.55,
          },
        ],
      },
      {
        id: nanoid(),
        title: locale === 'zh' ? '技术栈' : 'Tech Stack',
        docType: 'tech_stack',
        sortOrder: 2,
        blocks: [
          {
            id: nanoid(),
            blockType: 'list',
            content: {
              items: languageItems.length > 0
                ? languageItems
                : [locale === 'zh' ? '未能从索引中识别语言分布' : 'No language distribution available from the index'],
              ordered: false,
            },
            contentFormat: 'rich_text_json',
            sourceHints: topSourceHints,
            confidence: 0.6,
          },
        ],
      },
    ],
  });
}

// ── Service ──────────────────────────────────────────────────────────────────

export const wikiAgentService = {
  async generateWiki(
    scan: CodeMapScanResult,
    opts: { locale?: 'zh' | 'en'; model?: string; projectId?: string } = {},
  ): Promise<WikiGeneratorOutput> {
    const locale = opts.locale ?? 'zh';

    try {
      const rawOutput = await generateGatewayObject(
        {
          purpose: 'wiki',
          projectId: opts.projectId,
          model: opts.model,
          messages: [
            { role: 'system', content: buildLanguageDirective(locale) + buildSystemPrompt() },
            { role: 'user', content: buildUserPrompt(scan) },
          ],
        },
        RawWikiGeneratorOutputSchema,
      );

      const normalized = normalizeGeneratedWiki(rawOutput, locale);
      if (normalized.documents.length > 0) {
        return normalized;
      }
      throw new Error('Wiki generator returned no usable documents');
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err) && typeof err.text === 'string') {
        const recovered = parseRawWikiOutputText(err.text);
        if (recovered) {
          const normalized = normalizeGeneratedWiki(recovered, locale);
          if (normalized.documents.length > 0) {
            logger.warn(
              { projectId: opts.projectId, cause: err.message },
              'wiki generator: recovered structured output after schema mismatch',
            );
            return normalized;
          }
        }
      }

      logger.warn(
        { err, projectId: opts.projectId },
        'wiki generator: falling back to analyzer-derived wiki draft',
      );
      return buildFallbackWiki(scan, locale);
    }
  },
};
