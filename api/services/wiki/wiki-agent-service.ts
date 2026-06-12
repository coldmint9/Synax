// ---------------------------------------------------------------------------
// api/services/wiki/wiki-agent-service.ts
//
// Wiki Generator Agent — 调用 LLM 生成 markdown WikiDocument 草稿
// ---------------------------------------------------------------------------

import * as z from 'zod/v4';
import { generateGatewayObject } from '../llm-runtime/gateway.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import { logger } from '../../lib/logger.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import type { WikiDocType, WikiReference } from './contracts.js';

const WikiDocumentDraftSchema = z.object({
  title: z.string(),
  docType: z.enum(['landscape', 'topology', 'module', 'flow', 'data']),
  sortOrder: z.number().optional(),
  markdown: z.string(),
  references: z.array(z.object({
    filePath: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    symbol: z.string().optional(),
    confidence: z.number().optional(),
  })),
});

const WikiGeneratorOutputSchema = z.object({
  documents: z.array(WikiDocumentDraftSchema),
});

export type WikiDocumentDraft = z.infer<typeof WikiDocumentDraftSchema>;
export type WikiGeneratorOutput = z.infer<typeof WikiGeneratorOutputSchema>;

function buildSystemPrompt(): string {
  return `You are a senior software architect generating a Codebase Design Wiki as markdown documents.
Rules:
- Allowed docType values: landscape, topology, module, flow, data.
- Each document must include markdown body with ## sections, tables/diagrams/code as appropriate.
- references[] must cite real file paths or symbols from the code index.
- Do not invent APIs, types, or modules that are not in the code index.
- Output only valid json matching the schema exactly.`;
}

function buildUserPrompt(scan: CodeMapScanResult): string {
  const { codeIndex, moduleMap } = scan;

  const fileSummary = codeIndex.files
    .slice(0, 60)
    .map(f => `${f.path} (${f.language})`)
    .join('\n');

  const symbolSummary = codeIndex.symbols
    .slice(0, 80)
    .map(s => `${s.qualifiedName} [${s.kind}]`)
    .join('\n');

  const langs = (moduleMap?.languages ?? []).map(l => l.language).join(', ');

  return [
    'Generate wiki documents for this codebase.',
    '',
    `Languages: ${langs || 'unknown'}`,
    '',
    '## Files (sample)',
    fileSummary,
    '',
    '## Symbols (sample)',
    symbolSummary,
    '',
    'Produce at least: 1 landscape, 1 topology, and 1 module document with substantive markdown.',
  ].join('\n');
}

function fallbackDocuments(scan: CodeMapScanResult): WikiGeneratorOutput {
  const topFiles = scan.codeIndex.files.slice(0, 5).map(f => f.path);
  const refs: WikiReference[] = topFiles.map(filePath => ({ filePath, confidence: 0.5 }));

  return {
    documents: [
      {
        title: 'Project Overview',
        docType: 'landscape',
        sortOrder: 0,
        markdown: `# Project Overview\n\n## Tech Stack\n\n| Layer | Notes |\n| --- | --- |\n| Code | ${topFiles.length} sampled files |\n\n## Repository Layout\n\n${topFiles.map(f => `- ${f}`).join('\n')}\n`,
        references: refs,
      },
    ],
  };
}

export const wikiAgentService = {
  async generateWiki(
    scan: CodeMapScanResult,
    opts: { locale?: 'zh' | 'en'; projectId?: string } = {},
  ): Promise<WikiGeneratorOutput> {
    const locale = opts.locale ?? 'zh';
    const prompt = buildLanguageDirective(locale) + '\n\n' + buildUserPrompt(scan);

    try {
      const result = await generateGatewayObject(
        {
          projectId: opts.projectId,
          purpose: 'wiki-generator',
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: prompt },
          ],
        },
        WikiGeneratorOutputSchema,
      );

      if (!result.documents.length) {
        logger.warn('wiki-agent: empty generator output, using fallback');
        return fallbackDocuments(scan);
      }

      return result;
    } catch (err) {
      logger.warn({ err }, 'wiki-agent: generation failed, using fallback');
      return fallbackDocuments(scan);
    }
  },
};
