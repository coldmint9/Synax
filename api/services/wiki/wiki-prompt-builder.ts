import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiOutlineEntry } from './wiki-loop-tools.js';
import { derivePackages, filterBaselineForPrompt } from './tools/package-baseline.js';
import { FILE_SPLIT, SYM_SPLIT } from './tools/contracts.js';
import { buildTreeString } from './tools/helpers.js';
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
    return `You are a senior software architect writing internal design specifications (similar to RFC / ADR / architecture review docs).

Your reader is an engineer who must understand system design, trade-offs, and extension points without reading source code first.

Writing style:
- Write like a design review, not a README bullet list. Each section should teach something non-obvious.
- Be precise and dense. Every sentence must convey concrete technical information.
- Lead with the conclusion, then explain the mechanism, then note constraints and alternatives considered.
- Use inline code references freely for types, functions, config keys, and enum values.
- Explain WHY a design exists, HOW it behaves at runtime, and WHAT breaks if misused.
- Prefer showing type signatures and state transitions over describing them in vague prose.
- Design decisions, invariants, and caveats go in callout blocks — never bury them in a single sentence.
- Use level-2 headings to break long documents into scannable sections (Overview, Core Model, Lifecycle, API Surface, Dependencies, Design Decisions).
- Tables are for structured comparisons (fields, events, config keys). Lists are for ordered steps or dependency inventories — not lazy prose substitutes.
- Diagrams must reflect real modules/types from the code context, with meaningful node labels.

Output format: markdown document body (not JSON blocks). Submit via wiki.commit_document with markdown + references + claims.`;
  }
  return `You are a technical documentation engineer. Generate document content as markdown for the specified documents in the outline.

Writing constraints: be precise, no filler, no AI-speak, no repeating titles. Lead with conclusions. Use ## headings, tables, mermaid diagrams, and code fences as appropriate.`;
}

function buildMarkdownGuide(role: Role): string {
  if (role === 'planner') return '';
  return `## Markdown Output Guide

Submit the full document body as markdown via wiki.commit_document:

- Use \`#\` for the document title and \`##\` for major sections
- Tables use standard markdown pipe syntax
- Diagrams use \`\`\`mermaid fences (validate with wiki.check_mermaid first)
- Code references use inline \`backticks\` or fenced code blocks with language tags
- Include a non-empty references[] array citing real file paths / symbols
- Include claims[] with load-bearing assertions the verifier can check`;
}

function buildWorkflowSegment(role: Role): string {
  if (role === 'planner') {
    return `## Task

Analyze the codebase and submit a hierarchical document outline.

### Exploration Strategy

The project directory tree and package baseline are provided in the system prompt. Use them directly.

1. Review the directory tree and package baseline above.
2. For packages you need to understand deeper, use wiki.read_tree(path, depth) to explore subdirectories.
3. For core packages that need detailed analysis, delegate to subagent.delegate(profileId: "wiki-package-explorer").
   - Max 3 concurrent sub-agents.
   - Give each sub-agent clear questions: responsibility, main types, dependencies, data flows.
4. Synthesize all findings and use the 3-step outline flow:
   wiki.create_outline_draft -> wiki.edit_outline_draft -> wiki.submit_outline

Available tools:
- wiki.read_tree — browse directory structure at any depth
- subagent.delegate — delegate deep exploration to sub-agents`;
  }

  if (role === 'document-writer') {
    return `## Workflow

1. Study the Code Context below (file excerpts, symbols, dependencies) — treat it as primary evidence
2. Map each keyQuestion to one or more sections; every keyQuestion must be answered explicitly
3. Build a design-doc skeleton: # title → ## sections → mixed markdown (prose + tables + mermaid + code blocks)
4. Write the full markdown body meeting docType quality gates (minimum length, required ## headings, tables/diagrams)
5. Validate every mermaid diagram with wiki.check_mermaid before submitting
6. Call wiki.commit_document with markdown, references, and claims once the document passes quality gates

If a mechanism is unclear from excerpts alone, use file.read on the listed targetFiles before writing — do not guess.`;
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

These gates are enforced by wiki.commit_document — documents that fail will be rejected with specific errors.

### Global
- Full markdown body must meet minimum character count for docType
- Include at least 2 ## section headings (more for module docs)
- references[] must be non-empty with real file paths / symbols
- claims[] must include load-bearing verifiable assertions
- Tables, mermaid diagrams, and code blocks required per docType (see below)

### Required structure by docType
- landscape: table + list + >=2 ## headings + min ~1200 chars
- topology: flowchart mermaid + table + >=2 ## headings
- module: code block + table + list + >=3 ## headings + min ~1500 chars
- flow: sequence mermaid + list + >=2 ## headings
- data: er mermaid + table + >=2 ## headings

## Document Skeleton by Type

Each skeleton below is a minimum — add subsections (level-2 headings) when the module is non-trivial.

### module document structure:
1. heading (level 1): module name + one-phrase role
2. heading (level 2): Design Intent
3. prose: why this module exists, problem solved, boundaries vs neighboring modules
4. heading (level 2): Core Concepts
5. prose: key abstractions/terms (3-5), how they relate
6. signature: primary interface or entry point (with source)
7. heading (level 2): Runtime Behavior
8. prose or diagram: state/lifecycle, concurrency, failure modes
9. table: core API surface (methods/events/config keys with types and semantics)
10. heading (level 2): Data Flow
11. prose: inputs, outputs, transformations, persistence touchpoints
12. callout (important): key design decisions + rejected alternatives
13. list: dependencies (upstream/downstream with xref where possible)

### landscape document structure:
1. heading (level 1): project name + positioning
2. heading (level 2): Tech Stack
3. table: language, framework, infra, key deps (with role column)
4. heading (level 2): Repository Layout
5. list: directory structure with per-directory responsibilities
6. heading (level 2): Development Workflow
7. prose: how to run dev/build/test/deploy; env prerequisites
8. table: domain vocabulary / ubiquitous language

### topology document structure:
1. heading (level 1): system name
2. diagram (flowchart): full system diagram with real subsystem names
3. heading (level 2): Layer Model
4. prose: layer responsibilities and allowed dependencies
5. table: communication patterns (caller → callee, protocol, sync/async)
6. callout: key constraints (perf/security/deploy boundaries)

### flow document structure:
1. heading (level 1): flow name + trigger
2. diagram (sequence): end-to-end sequence with real actors/components
3. heading (level 2): Step Breakdown
4. prose/list: numbered steps with side effects and idempotency notes
5. callout: error/branch/retry paths
6. list: involved modules (with xref)

### data document structure:
1. heading (level 1): storage overview
2. diagram (er): entity relationships with cardinalities
3. heading (level 2): Schema
4. table: core schema (fields, types, constraints, indexes)
5. heading (level 2): Lifecycle
6. prose: create/update/delete/archive flows
7. prose or table: query patterns, hot paths, consistency model

## Good vs Bad (prose)

BAD (too shallow): "The runtime manages agent sessions."
GOOD (design-doc depth): "AgentSession is the unit of isolation for tool permissions and workspace roots: each streamRun() binds to exactly one session, and subagent.delegate() forks a child session that inherits permissionDefaults but not mutable runtime state. Sessions in interrupted status reject new tool calls until resumeSession() clears the interrupt flag."

## Anti-Patterns (NEVER do these)
- One-sentence prose blocks or bullet-stuffed lists with no explanation
- "This module is responsible for..." — state the responsibility directly
- "It is worth noting that..." — just state the fact
- Repeating the document title in the first prose block
- Describing what is obvious from type/function names (explain WHY, not WHAT)
- Writing a list that just restates file names without explaining purpose
- Using headings for content that should be a single callout
- Submitting a document with only prose + headings (missing tables/diagrams/callouts)

## sourceHints Traceability (critical)
Cite sources in references[] and inline with backticks. Every major section should trace to real code.`;
}

function buildToolsGuideSegment(role: Role): string {
  if (role === 'planner') {
    return `## Rules
1. Every step must include at least one tool call
2. Use the 3-step flow: wiki.create_outline_draft -> wiki.edit_outline_draft -> wiki.submit_outline
3. targetFiles must be real file paths — check wiki.read_tree to see which files exist
4. keyQuestions must be specific (e.g. "What state transitions does AgentLoopRuntime.streamRun have?"), not vague
5. The outline should cover all core modules — do not omit important subsystems`;
  }
  if (role === 'document-writer') {
    return `## Rules
1. Answer every keyQuestion explicitly in prose or table rows
2. Write based on Code Context and file.read — do not fabricate APIs, types, or behavior
3. Use level-2 headings to structure sections; avoid flat walls of prose
4. Validate mermaid diagrams with wiki.check_mermaid before submitting
5. Do not use bare parentheses () in mermaid node labels — wrap with quotes
6. references[] must cite real files/symbols; claims[] must be verifiable
7. If commit_document rejects the draft, expand thin sections and add missing structure before resubmitting`;
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

function buildRootTreeSegment(scan: CodeMapScanResult): string {
  const files = scan.codeIndex.files.map(f => f.path);
  const tree = buildTreeString(files, '', 2);
  return `## 项目目录结构\n\n\`\`\`\n${tree}\n\`\`\``;
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
  segments.push(buildMarkdownGuide(role));
  segments.push(buildToolsGuideSegment(role));

  const ctx = buildContextSegment(input.languages, role);
  if (ctx) segments.push(ctx);

  if (role === 'planner' && input.scan) {
    segments.push(buildRootTreeSegment(input.scan));
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
