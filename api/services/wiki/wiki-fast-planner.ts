/**
 * Fast-path wiki outline generation: one structured-output LLM call over a
 * rich deterministic context, programmatic validation, and at most one repair
 * call. Returns null when the result still fails validation, so the caller
 * can fall back to the agentic planner.
 */
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { generateGatewayObject } from '../llm-runtime/gateway.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiOutlineEntry } from './tools/contracts.js';
import { WIKI_DOC_TYPES } from './tools/contracts.js';
import { fullValidation, blockingErrors, formatErrors } from './tools/outline-validation.js';
import { buildOutlineContext } from './wiki-outline-context.js';
import { buildFastPlannerSystemPrompt, formatLanguages } from './wiki-prompt-builder.js';
import { buildOutlineLanguageRequirement } from '../prompts/language-directive.js';

const OUTLINE_MAX_TOKENS = 6000;
const TEMPERATURE = 0.2;

const OutlineDocumentSchema = z.object({
  id: z.string().min(1).describe('Unique local ID (e.g. "root-overview", "mod-auth").'),
  docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('One of: landscape, topology, module, flow, data.'),
  title: z.string().min(1).describe('Concise document title.'),
  sortOrder: z.number().int().optional().describe('Display order (default 0).'),
  targetFiles: z.array(z.string()).default([]).describe('Real file paths to read when writing this document.'),
  keyQuestions: z.array(z.string()).default([]).describe('At least 2 specific questions the document must answer.'),
});

const OutlineSchema = z.object({
  documents: z.array(OutlineDocumentSchema).min(1),
});

type OutlineOutput = z.infer<typeof OutlineSchema>;

export interface FastOutlineOptions {
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
}

export interface FastOutlineResult {
  outline: WikiOutlineEntry[];
  repaired: boolean;
}

export async function generateOutlineFast(
  scan: CodeMapScanResult,
  opts: FastOutlineOptions,
): Promise<FastOutlineResult | null> {
  const locale = opts.locale ?? 'zh';
  const validPaths = new Set(scan.codeIndex.files.map(f => f.path));
  const { context, corePackages } = buildOutlineContext(scan, opts.workDir);
  const systemPrompt = buildFastPlannerSystemPrompt(locale);
  const userPrompt = [
    `## Language Composition`,
    formatLanguages(scan),
    '',
    context,
    '',
    buildOutlineLanguageRequirement(locale),
    '',
    'Produce the complete document outline now as structured output.',
  ].join('\n');

  let output: OutlineOutput;
  try {
    output = await generateGatewayObject(
      {
        projectId: opts.projectId,
        purpose: 'wiki-outline',
        temperature: TEMPERATURE,
        maxTokens: OUTLINE_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      OutlineSchema,
    );
  } catch (err) {
    logger.warn({ err, projectId: opts.projectId }, 'wiki-fast-planner: initial outline call failed');
    return null;
  }

  let documents = sanitizeOutline(output.documents, validPaths);
  let errors = blockingErrors(fullValidation(documents, validPaths, { corePackages, strictQuality: true }));
  if (errors.length === 0) {
    return { outline: documents, repaired: false };
  }

  logger.info(
    { projectId: opts.projectId, errorCount: errors.length },
    'wiki-fast-planner: outline failed validation, attempting one repair call',
  );

  try {
    const repairPrompt = [
      'Your previous outline failed validation. Fix ONLY the listed issues and return the full corrected outline.',
      '',
      '## Validation Errors',
      formatErrors(errors),
      '',
      '## Previous Outline',
      JSON.stringify({ documents }, null, 2),
      '',
      'Remember: targetFiles must be existing paths from the original context; every core package needs a covering module document; each document needs at least 2 specific keyQuestions.',
    ].join('\n');

    const repaired = await generateGatewayObject(
      {
        projectId: opts.projectId,
        purpose: 'wiki-outline',
        temperature: TEMPERATURE,
        maxTokens: OUTLINE_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: JSON.stringify({ documents }) },
          { role: 'user', content: repairPrompt },
        ],
      },
      OutlineSchema,
    );

    documents = sanitizeOutline(repaired.documents, validPaths);
    errors = blockingErrors(fullValidation(documents, validPaths, { corePackages, strictQuality: true }));
    if (errors.length === 0) {
      return { outline: documents, repaired: true };
    }
    logger.warn(
      { projectId: opts.projectId, errors: errors.map(e => e.message) },
      'wiki-fast-planner: outline still invalid after repair, falling back to agent planner',
    );
    return null;
  } catch (err) {
    logger.warn({ err, projectId: opts.projectId }, 'wiki-fast-planner: repair call failed');
    return null;
  }
}

/**
 * Programmatic cleanup of auto-fixable issues before validation:
 * drop hallucinated targetFiles, dedupe IDs, normalize missing arrays.
 */
export function sanitizeOutline(
  documents: OutlineOutput['documents'],
  validPaths: Set<string>,
): WikiOutlineEntry[] {
  const seen = new Set<string>();
  const result: WikiOutlineEntry[] = [];

  for (const doc of documents) {
    let id = doc.id.trim() || `doc-${result.length + 1}`;
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);

    result.push({
      id,
      docType: doc.docType as WikiOutlineEntry['docType'],
      title: doc.title.trim(),
      sortOrder: doc.sortOrder,
      targetFiles: (doc.targetFiles ?? []).filter(p => validPaths.has(p)),
      keyQuestions: (doc.keyQuestions ?? []).map(q => q.trim()).filter(Boolean),
    });
  }

  return result;
}
