import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiOutlineEntry } from './wiki-loop-tools.js';
import { derivePackages, filterBaselineForPrompt } from './tools/package-baseline.js';
import { FILE_SPLIT, SYM_SPLIT } from './tools/contracts.js';
import { buildLanguageDirective, type Locale } from '../prompts/language-directive.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WikiPromptInput {
  role: 'planner' | 'writer' | 'document-writer';
  languages: string;
  locale: 'zh' | 'en';
  scan?: CodeMapScanResult;
  outline?: WikiOutlineEntry[];
  continuation?: { completedTitles: string[]; remainingCount: number };
  preloadedContext?: string;
  documentContext?: string;
  documentEntry?: WikiOutlineEntry;
}

// ── Format language composition from scan ────────────────────────────────────

export function formatLanguages(scan: CodeMapScanResult): string {
  const langs = scan.moduleMap?.languages ?? [];
  if (langs.length === 0) return 'unknown';
  return langs
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 5)
    .map(l => `${l.language}(${l.fileCount})`)
    .join(', ');
}

// ── Segment builders ─────────────────────────────────────────────────────────

type Role = 'planner' | 'writer' | 'document-writer';

function buildIdentitySegment(role: Role): string {
  if (role === 'planner') {
    return 'You are a senior software architect. Your sole task is: analyze the codebase structure and output a flat document outline grouped by type (landscape, topology, module, flow, data).\n\nYou do not write document content — only plan the document structure.';
  }
  if (role === 'document-writer') {
    return `You are a technical documentation engineer writing for developers who need to understand software design without reading source code.

Writing style:
- Be precise and dense. Every sentence must convey concrete technical information.
- Lead with the conclusion, then explain the mechanism.
- Use inline code references freely for types, functions, and values.
- Never use filler phrases: "It is worth noting", "This module is responsible for", "As mentioned above", "In order to", "It should be noted that".
- Never repeat the title in the first paragraph.
- Never describe what's obvious from names alone — explain WHY and HOW, not WHAT.
- Prefer showing type signatures over describing them in prose.
- Design decisions go in callout blocks, not buried in paragraphs.

Output format: structured JSON blocks (not markdown). Each block has a blockType and a content object matching the schema below.`;
  }
  return `You are a technical documentation engineer. Generate document content as structured JSON blocks for the specified documents in the outline.

Writing constraints: be precise, no filler, no AI-speak, no repeating titles. Lead with conclusions. Design decisions go in callout blocks.`;
}

function buildJsonSchemaGuide(role: Role): string {
  if (role === 'planner') return '';
  return `## Block Content JSON Schema

Each block submitted to wiki.commit_document must have blockType + content (JSON object). Reference:

### heading
{ "level": 1|2|3, "text": "Section title", "anchor": "optional-slug" }

### prose
{ "segments": [
  { "type": "text", "value": "plain text" },
  { "type": "bold", "value": "emphasized text" },
  { "type": "code", "value": "functionName()" },
  { "type": "xref", "target": "document-id", "label": "display text" }
] }

### signature
{ "language": "typescript",
  "tokens": [
    { "type": "keyword"|"type"|"name"|"param"|"punctuation"|"comment", "value": "..." }
  ],
  "source": { "file": "path/to/file.ts", "line": 42 }
}
Token types: keyword (async, export, function, class, interface, type, const, let, return, extends, implements), type (type names, interfaces, generics), name (function/method/variable names), param (parameter names), punctuation (braces, parens, colons, arrows, commas), comment (inline notes).

### callout
{ "level": "info"|"warn"|"important",
  "title": "Optional heading",
  "body": [/* Segment[] — same as prose.segments */]
}
Use for: design decisions, constraints, non-obvious behavior, caveats.

### table
{ "headers": [{ "key": "field", "label": "Field" }, { "key": "type", "label": "Type" }],
  "rows": [{ "field": "id", "type": { "type": "code", "value": "string" } }]
}
Cell values: plain string OR { "type": "code", "value": "..." } for mono rendering.

### diagram
{ "diagramType": "flowchart"|"sequence"|"er"|"state",
  "code": "graph TD\\n  A --> B",
  "caption": "Optional description"
}
Must validate with wiki.check_mermaid before submitting.

### list
{ "ordered": boolean, "items": [{ "segments": [/* Segment[] */], "children": [/* recursive */] }] }`;
}

function buildWorkflowSegment(role: Role): string {
  if (role === 'planner') {
    return `## Task

Analyze the codebase and submit a hierarchical document outline.

### Exploration Strategy

Core packages have already been explored for you by parallel explorer agents — their findings appear under "Pre-loaded Exploration Results" below. Use that evidence directly.

1. Review the pre-loaded exploration results and the Package Baseline.
2. Read any remaining files yourself (file.read / grep.search) only where the pre-loaded context has gaps.
3. Call wiki.create_outline_draft with your best-guess outline. It saves the draft and returns any structural issues as validationErrors.
4. Call wiki.edit_outline_draft to fix remaining issues (add missing docs, fix targetFiles, update keyQuestions). Each edit runs full validation and returns updated validationErrors. Iterate until the list is empty.
5. Call wiki.submit_outline (no arguments) to lock the outline. If it returns errors, go back to step 4.

Available tools:
- wiki.read_modules / wiki.read_tree / wiki.read_code_index / wiki.read_graph — codebase structure
- wiki.read_call_graph / wiki.impact_analysis — dependency analysis
- file.read / file.list / file.glob / grep.search — direct file access for gap-filling`;
  }

  if (role === 'document-writer') {
    return `## Workflow

1. Read the code context provided below (files, symbols, dependencies)
2. Organize content structure based on keyQuestions
3. Generate all blocks as structured JSON (minimum count depends on docType — see Quality Requirements)
4. Call wiki.commit_document to submit the document

No need to call code exploration tools — all necessary information is provided in the context.`;
  }

  return `## Writing Strategy

Generate documents one by one, focusing on all blocks of one document at a time.

1. **Root-level documents** (directory_tree, overview, architecture) — generate directly, requires global perspective
2. **Module-level documents** (module_spec, etc.) — delegate to explorer sub-agents, then format and submit

subagent.delegate behavior:
- Use profileId: "explorer" (generic code exploration)
- You will block until the sub-agent completes
- Maximum 5 concurrent subtasks

After receiving the sub-agent's summary, format into blocks and call wiki.commit_document.

## Execution Order (topological)
Must submit in parent → child order. parentPlanId points to the id in the outline.`;
}

function buildConstraintsSegment(role: Role): string {
  if (role === 'planner') {
    return `## Outline Structure Requirements

Follow the 5-type flat document hierarchy:

- landscape: 1 per project (global entry point — tech stack, directory, concepts)
- topology: architecture connections and communication patterns
- module: one per core subsystem (minimum 8 blocks when written)
- flow: key end-to-end operations (minimum 6 blocks when written)
- data: storage layer, schemas, lifecycle (minimum 5 blocks when written)

Constraints:
- Must include: 1 landscape, 1 topology, modules for all core packages
- Documents are FLAT — no parentId nesting. Use xref cross-references instead.
- Each entry must specify targetFiles (real file paths) and keyQuestions
- title must be concise — no parenthetical elaborations`;
  }

  return `## Quality Requirements

- All block content must be valid JSON matching the schema for its blockType
- prose segments total character count >= 200 per block
- signature blocks must include source file reference with real file path
- callout blocks are for design decisions and constraints, not generic notes
- table blocks: headers and row keys must be consistent across all rows
- diagram blocks: mermaid code must pass wiki.check_mermaid validation
- Minimum blocks by docType: landscape=6, topology=5, module=8, flow=6, data=5

## Document Skeleton by Type

### module document structure:
1. heading (level 1): module name + one-phrase role
2. prose: design intent — why this module exists, what problem it solves
3. prose: core concepts — key abstractions/terms (3-5)
4. signature: primary interface or entry point
5. prose or diagram: state/lifecycle (if stateful)
6. table or signature: core API surface
7. prose: data flow — inputs, outputs, transformations
8. callout: key design decisions
9. list: dependencies (who depends on this, what it depends on)

### landscape document structure:
1. heading: project name + positioning
2. table: tech stack (language, framework, key deps)
3. list: directory structure with per-directory roles
4. prose: how to run (dev/build/test)
5. table: domain vocabulary

### topology document structure:
1. heading: system name
2. diagram (flowchart): full system diagram
3. prose: layer descriptions
4. table: communication patterns between layers
5. callout: key constraints (perf/security/deploy boundaries)

### flow document structure:
1. heading: flow name + trigger
2. diagram (sequence): end-to-end sequence diagram
3. prose/list: step breakdown
4. callout: error/branch paths
5. list: involved modules (with xref)

### data document structure:
1. heading: storage overview
2. diagram (er): entity relationships
3. table: core schema (fields, types, constraints)
4. prose: data lifecycle
5. prose or table: query patterns and indexes

## Anti-Patterns (NEVER do these)
- "This module is responsible for..." — state the responsibility directly
- "It is worth noting that..." — just state the fact
- Repeating the document title in the first prose block
- Describing what is obvious from type/function names (explain WHY, not WHAT)
- Writing a list that just restates file names without explaining purpose
- Using headings for content that should be a single callout

## sourceHints Traceability (critical)
Every non-heading block MUST have sourceHints. Use qualified names (e.g. ClassName.methodName) or file paths.`;
}

function buildToolsGuideSegment(role: Role): string {
  if (role === 'planner') {
    return `## Rules
1. Every step must include at least one tool call
2. Use the 3-step flow: wiki.create_outline_draft -> wiki.edit_outline_draft -> wiki.submit_outline
3. targetFiles must be real file paths from wiki.read_code_index(kind: "files") - check for exact paths
4. keyQuestions must be specific (e.g. "What state transitions does AgentLoopRuntime.streamRun have?"), not vague
5. The outline should cover all core modules — do not omit important subsystems`;
  }
  if (role === 'document-writer') {
    return `## Rules
1. Write directly based on the provided code context — do not fabricate non-existent APIs or types
2. Validate diagram blocks with wiki.check_mermaid before submitting
3. Do not use bare parentheses () in mermaid node labels — wrap with quotes
4. Every non-heading block must have sourceHints`;
  }
  return `## Rules
1. Every step must include a tool call
2. Submit in topological order: parent documents before children
3. Validate diagram blocks with wiki.check_mermaid before submitting
4. Do not fabricate non-existent APIs or types
5. Do not use bare parentheses () in mermaid node labels — wrap with quotes`;
}

function buildContextSegment(languages: string, role: Role): string {
  if (role !== 'planner') return '';
  return `## Language Composition\n${languages}`;
}

function buildContinuationSegment(ctx: { completedTitles: string[]; remainingCount: number }): string {
  const completed = ctx.completedTitles.map(t => `  - ✓ ${t}`).join('\n');

  return `## Continuation Context

The following documents are already completed — do not regenerate:
${completed}

Remaining documents to generate: ${ctx.remainingCount}
Only generate content for incomplete documents.`;
}

function buildPreloadedContextSegment(context: string): string {
  return `## Pre-loaded Exploration Results (from Planner phase)

The following codebase information was explored during the Planner phase. You can use this data directly without repeating the same tool calls:

${context}`;
}

function buildOutlineSegment(outline: WikiOutlineEntry[]): string {
  return `## Document Outline\n\n${JSON.stringify(outline, null, 2)}`;
}

function buildPackageBaselineSegment(scan: CodeMapScanResult): string {
  const baseline = filterBaselineForPrompt(derivePackages(scan));

  if (baseline.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Package Baseline');
  lines.push('Core modules below. Each needs at least one document; packages marked [SPLIT] have enough surface area to warrant sub-documents keyed to their hub symbols.');
  lines.push('');

  for (const pkg of baseline) {
    const needsSplit = pkg.fileCount >= FILE_SPLIT && pkg.symbolCount >= SYM_SPLIT;
    const hubs = pkg.hubSymbols.slice(0, 3).map(h => h.name).join(', ');
    const splitHint = needsSplit ? ` → [SPLIT] parent + sub-docs (hubs: ${hubs})` : '';
    lines.push(`- ${pkg.label}  ${pkg.fileCount}f / ${pkg.symbolCount}s${splitHint}`);
  }

  lines.push('');
  lines.push('## Directory Tree Baseline');
  const topDirs = scan.moduleMap?.topDirs ?? [];
  lines.push(topDirs.map(d => (d as { path?: string; dir?: string }).path ?? (d as { path?: string; dir?: string }).dir ?? '').filter(Boolean).join(', '));

  return lines.join('\n');
}

// ── Main builder ─────────────────────────────────────────────────────────────

export function buildWikiPrompt(input: WikiPromptInput): string {
  const { locale, role } = input;
  const segments: string[] = [];

  // Language output directive — tells the LLM which language to produce user-facing text in
  segments.push(buildLanguageDirective(locale));

  segments.push(buildIdentitySegment(role));
  segments.push(buildWorkflowSegment(role));

  if (role === 'writer' && input.outline) {
    segments.push(buildOutlineSegment(input.outline));
  }

  if (role === 'document-writer' && input.documentEntry) {
    segments.push(`## Current Document\n\n- Title: ${input.documentEntry.title}\n- Type: ${input.documentEntry.docType}\n- ID: ${input.documentEntry.id}`);
  }

  segments.push(buildConstraintsSegment(role));
  segments.push(buildJsonSchemaGuide(role));
  segments.push(buildToolsGuideSegment(role));

  const ctx = buildContextSegment(input.languages, role);
  if (ctx) segments.push(ctx);

  if (role === 'planner' && input.scan) {
    segments.push(buildPackageBaselineSegment(input.scan));
  }

  if (input.documentContext) {
    segments.push(`## Code Context\n\n${input.documentContext}`);
  }

  if (input.preloadedContext) {
    segments.push(buildPreloadedContextSegment(input.preloadedContext));
  }

  if (input.continuation) {
    segments.push(buildContinuationSegment(input.continuation));
  }

  return segments.join('\n\n');
}
