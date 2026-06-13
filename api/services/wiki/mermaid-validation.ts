/**
 * Mermaid syntax validation for wiki document generation.
 * Uses beautiful-mermaid (Node-safe, no DOM) plus static lint rules aligned with browser mermaid.
 */

type RenderMermaidSVG = (text: string, options?: { bg?: string; fg?: string }) => string;

let renderMermaidSVG: RenderMermaidSVG | null = null;

async function getRenderer(): Promise<RenderMermaidSVG> {
  if (!renderMermaidSVG) {
    const mod = await import('beautiful-mermaid');
    renderMermaidSVG = mod.renderMermaidSVG;
  }
  return renderMermaidSVG;
}

export type DiagramKind = 'flowchart' | 'sequence' | 'er' | 'state' | 'class' | 'other' | 'unknown';

export interface MermaidBlock {
  index: number;
  startLine: number;
  code: string;
}

export interface MermaidValidationResult {
  ok: boolean;
  diagramType: string;
  diagramKind: DiagramKind;
  error?: string;
  hints?: string[];
}

export interface MermaidBlockValidationResult extends MermaidValidationResult {
  blockIndex: number;
  startLine: number;
}

/** Strip optional ```mermaid fences from agent input. */
export function normalizeMermaidInput(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*\n?([\s\S]*?)```\s*$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/** Extract all mermaid fenced blocks from markdown. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(markdown)) !== null) {
    const before = markdown.slice(0, match.index);
    const startLine = before.split('\n').length;
    blocks.push({
      index: index++,
      startLine,
      code: match[1].trim(),
    });
  }
  return blocks;
}

/** Detect diagram kind from the first non-empty, non-comment line. */
export function detectDiagramKind(code: string): DiagramKind {
  const firstLine = code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('%%'));
  if (!firstLine) return 'unknown';

  const lower = firstLine.toLowerCase();
  if (/^(graph|flowchart)\b/.test(lower)) return 'flowchart';
  if (/^sequencediagram\b/.test(lower)) return 'sequence';
  if (/^erdiagram\b/.test(lower)) return 'er';
  if (/^statediagram(-v2)?\b/.test(lower)) return 'state';
  if (/^classdiagram\b/.test(lower)) return 'class';
  if (/^(pie|gantt|gitgraph|journey|mindmap|timeline|quadrantchart|xychart|blockdiagram|c4context)\b/.test(lower)) {
    return 'other';
  }
  return 'unknown';
}

/** Whether a detected kind satisfies a docType requirement keyword. */
export function diagramKindMatchesRequirement(kind: DiagramKind, requirement: string): boolean {
  const req = requirement.toLowerCase();
  if (req === 'flowchart') return kind === 'flowchart';
  if (req === 'sequence') return kind === 'sequence';
  if (req === 'er') return kind === 'er';
  if (req === 'state') return kind === 'state';
  return kind !== 'unknown';
}

const UNQUOTED_PARENS_IN_LABEL =
  /(?:\[[^\]"']*\([^)]*\)[^\]"']*\]|\([^)"']*\([^)]*\)[^)"']*\))/;

function lintMermaidCode(code: string): string[] {
  const hints: string[] = [];
  const trimmed = code.trim();
  if (!trimmed) {
    hints.push('Diagram is empty.');
    return hints;
  }
  if (detectDiagramKind(code) === 'unknown') {
    hints.push('Missing or unrecognized diagram header (e.g. flowchart TD, sequenceDiagram, erDiagram).');
  }
  if (UNQUOTED_PARENS_IN_LABEL.test(code)) {
    hints.push('Wrap node labels containing () in double quotes, e.g. A["foo(bar)"].');
  }
  return hints;
}

function formatParseError(message: string): { error: string; hints: string[] } {
  const hints: string[] = [];
  if (/\([^)]*\)/.test(message) && /parse error/i.test(message)) {
    hints.push('Wrap node labels containing () in double quotes, e.g. A["foo(bar)"].');
  }
  if (/expecting|invalid/i.test(message)) {
    hints.push('Check arrow syntax, node IDs, and that special characters in labels are quoted.');
  }
  return { error: message, hints };
}

/** Validate a single mermaid diagram definition (without fences). */
export async function validateMermaidCode(code: string): Promise<MermaidValidationResult> {
  const normalized = normalizeMermaidInput(code);
  const diagramKind = detectDiagramKind(normalized);
  const lintHints = lintMermaidCode(normalized);

  if (lintHints.some((h) => h === 'Diagram is empty.')) {
    return {
      ok: false,
      diagramType: 'unknown',
      diagramKind,
      error: 'Diagram is empty.',
      hints: lintHints,
    };
  }

  if (lintHints.some((h) => h.startsWith('Missing or unrecognized'))) {
    return {
      ok: false,
      diagramType: 'unknown',
      diagramKind,
      error: lintHints.find((h) => h.startsWith('Missing or unrecognized'))!,
      hints: lintHints,
    };
  }

  if (lintHints.some((h) => h.includes('double quotes'))) {
    return {
      ok: false,
      diagramType: diagramKind,
      diagramKind,
      error: 'Unquoted parentheses in node label.',
      hints: lintHints,
    };
  }

  try {
    const render = await getRenderer();
    render(normalized, { bg: '#ffffff', fg: '#000000' });
    return {
      ok: true,
      diagramType: diagramKind,
      diagramKind,
      hints: lintHints.length > 0 ? lintHints : undefined,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const parsed = formatParseError(message);
    const hints = [...new Set([...lintHints, ...parsed.hints])];
    return {
      ok: false,
      diagramType: diagramKind,
      diagramKind,
      error: parsed.error,
      hints: hints.length > 0 ? hints : undefined,
    };
  }
}

/** Validate all mermaid blocks in markdown; returns human-readable error strings for commit gates. */
export async function validateAllMermaidInMarkdown(markdown: string): Promise<string[]> {
  const blocks = extractMermaidBlocks(markdown);
  const errors: string[] = [];

  for (const block of blocks) {
    const result = await validateMermaidCode(block.code);
    if (!result.ok) {
      const hint = result.hints?.length ? ` Hint: ${result.hints[0]}` : '';
      errors.push(
        `Mermaid block #${block.index + 1} (line ${block.startLine}, ${result.diagramKind}): ${result.error ?? 'Invalid syntax.'}${hint}`,
      );
    }
  }

  return errors;
}

/** Validate one code string or all blocks in markdown; used by wiki.check_mermaid tool. */
export async function validateMermaidInput(input: {
  code?: string;
  markdown?: string;
}): Promise<MermaidBlockValidationResult[]> {
  if (input.markdown?.trim()) {
    const blocks = extractMermaidBlocks(input.markdown);
    if (blocks.length === 0) {
      const normalized = normalizeMermaidInput(input.markdown);
      const result = await validateMermaidCode(normalized);
      return [{ ...result, blockIndex: 0, startLine: 1 }];
    }
    const results: MermaidBlockValidationResult[] = [];
    for (const block of blocks) {
      const result = await validateMermaidCode(block.code);
      results.push({ ...result, blockIndex: block.index, startLine: block.startLine });
    }
    return results;
  }

  if (input.code?.trim()) {
    const result = await validateMermaidCode(input.code);
    return [{ ...result, blockIndex: 0, startLine: 1 }];
  }

  return [{
    ok: false,
    diagramType: 'unknown',
    diagramKind: 'unknown',
    blockIndex: 0,
    startLine: 1,
    error: 'Provide either code or markdown.',
    hints: ['Pass raw diagram code, or full markdown to validate all ```mermaid blocks.'],
  }];
}

export function formatMermaidValidationSummary(results: MermaidBlockValidationResult[]): string {
  if (results.length === 0) return 'No mermaid content to validate.';
  const lines = results.map((r) => {
    const loc = results.length > 1 ? `Block #${r.blockIndex + 1} (line ${r.startLine}): ` : '';
    if (r.ok) return `${loc}Valid (${r.diagramType}).`;
    const hint = r.hints?.[0] ? `\n  Hint: ${r.hints[0]}` : '';
    return `${loc}Syntax error: ${r.error ?? 'unknown'}${hint}`;
  });
  return lines.join('\n');
}
