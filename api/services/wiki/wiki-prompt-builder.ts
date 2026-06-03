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
    return 'You are a senior software architect. Your sole task is: analyze the codebase structure and output a hierarchical document outline.\n\nYou do not need to write any document content — only plan the document structure.';
  }
  if (role === 'document-writer') {
    return 'You are a senior technical documentation engineer. Your task is to generate detailed technical specification content for the specified document based on the provided code context. All necessary code information has been pre-loaded — write directly based on the context.';
  }
  return 'You are a senior technical documentation engineer. You have received a document outline, and your task is to generate detailed technical specification content for each document.';
}

function buildWorkflowSegment(role: Role): string {
  if (role === 'planner') {
    return `## Task

Analyze the codebase and submit a hierarchical document outline.

### Exploration Strategy (3-phase)

**Phase 1 — High-level scan (1-2 steps)**
Use wiki.read_modules, wiki.read_tree, wiki.read_code_index, and wiki.read_graph to understand the overall project structure. Identify which packages from the Package Baseline need deep exploration.

**Phase 2 — Concurrent deep exploration (1-2 steps)**
For each package that needs deep exploration (especially those marked [SPLIT]), delegate to an explorer subagent:
- Call subagent.delegate(profileId: "explorer", prompt: "Explore <dir>. Read key source files. Answer: <specific questions>")
- Give each subagent a SPECIFIC prompt: which directory to explore, which questions to answer, what to look for
- Launch up to 5 subagents concurrently in a single step — they run in parallel
- Each subagent returns a summary; you block until all complete

**Phase 3 — Synthesize & submit (1-2 steps)**
Review all subagent summaries. Read any remaining files yourself if gaps exist. Call wiki.submit_outline with a complete hierarchical outline.

Available tools:
- wiki.read_modules / wiki.read_tree / wiki.read_code_index / wiki.read_graph — codebase structure
- wiki.read_call_graph / wiki.impact_analysis — dependency analysis
- file.read / file.list / file.glob / grep.search — direct file access
- **subagent.delegate(profileId: "explorer")** — delegate package exploration (max 5 concurrent)`;
  }

  if (role === 'document-writer') {
    return `## Workflow

1. Read the code context provided below (files, symbols, dependencies)
2. Organize content structure based on keyQuestions
3. Generate all blocks (at least 6 blocks)
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

Follow the standard software design document format (high-level → detailed design):

Level 0 (Root — global perspective):
- directory_tree: Project directory structure and module responsibilities
- overview: Project overview
- architecture: System architecture

Level 1 (Module — each core subsystem):
- module_spec: Detailed specification for each core module
- data_model: Core data models (optional, data-intensive modules)
- api: API endpoint specifications (optional, modules with external interfaces)

Level 2 (Sub-module/flow — deep details):
- module_spec: Sub-module specifications
- flow: Key business flows

Constraints:
- Must include: 1+ directory_tree, 1+ overview, 1+ architecture
- Decide document count and nesting depth based on your understanding of the project
- Each entry must specify targetFiles (real file paths) and keyQuestions (specific, answerable questions)
- sortOrder determines display order among siblings
- title must be concise — no parenthetical elaborations`;
  }

  return `## Block Type Specifications
- heading: "# Title" format
- paragraph: At least 200 words, include specific technical details
- list: Each item with explanation
- table: Markdown table (Field|Type|Description|Constraints)
- code_ref: Key function signatures or code snippets
- diagram: Mermaid diagrams (must validate with wiki.check_mermaid before submitting)
- task: Task/checklist items

## module_spec documents must include (at least 6 blocks):
1. heading: "# {ModuleName} — {one-line responsibility}"
2. paragraph: Overview (200+ words, responsibility boundaries, design goals)
3. code_ref: Public interface signatures
4. table: Data model field table
5. diagram: Business flow diagram (mermaid flowchart)
6. list: Dependencies

## sourceHints Traceability (critical)
Every non-heading block must have sourceHints. Prefer qualifiedName (e.g. ClassName.methodName), then file paths.`;
}

function buildToolsGuideSegment(role: Role): string {
  if (role === 'planner') {
    return `## Rules
1. Every step must include at least one tool call
2. targetFiles must be real file paths seen in wiki.read_code_index
3. keyQuestions must be specific (e.g. "What state transitions does AgentLoopRuntime.streamRun have?"), not vague
4. The outline should cover all core modules — do not omit important subsystems`;
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
