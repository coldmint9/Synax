import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiOutlineEntry } from './wiki-loop-tools.js';
import { derivePackages, filterBaselineForPrompt } from './tools/package-baseline.js';
import { FILE_SPLIT, SYM_SPLIT } from './tools/contracts.js';
import { buildTreeString } from './tools/helpers.js';
import { buildLanguageDirective, buildOutlineLanguageRequirement, type Locale } from '../prompts/language-directive.js';
import { buildOutlineContext } from './wiki-outline-context.js';
import { resolveWikiAuthoringGuide } from './wiki-authoring-skill.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WikiPromptInput {
  role: 'planner' | 'writer' | 'document-writer';
  languages: string;
  locale: 'zh' | 'en';
  scan?: CodeMapScanResult;
  workDir?: string;
  projectId?: string;
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
    return 'You are a senior software architect. Your sole task is: analyze the codebase structure and output a hierarchical document outline (TOC) using parentId to express professional documentation structure.\n\nYou do not write document content — only plan the document structure. Titles express the hierarchy; docType is internal metadata for content rules, not UI grouping.';
  }
  if (role === 'document-writer') return '';
  return `You are a technical documentation engineer. Generate document content as markdown for the specified documents in the outline.

Writing constraints: be precise, no filler, no AI-speak, no repeating titles. Lead with conclusions. Use ## headings, tables, mermaid diagrams, and code fences as appropriate.`;
}

function buildMarkdownGuide(role: Role): string {
  if (role === 'planner') return '';
  if (role === 'document-writer') return '';
  return `## Markdown Output Guide

Submit the full document body as markdown via wiki.commit_document:

- Use \`#\` for the document title and \`##\` for major sections
- Subtitle as italic line immediately under the # title
- Callouts: \`> [!NOTE]\`, \`> [!IMPORTANT]\`, \`> [!WARNING]\`
- Tables, mermaid fences, fenced code with language tags
- Source lines after primary code fences: \`*Source: \`path:line\`*\`
- Non-empty references[] and claims[] with load-bearing assertions`;
}

function buildWorkflowSegment(role: Role): string {
  if (role === 'planner') {
    return `## Task

Analyze the codebase and submit a hierarchical document outline via tool calls.

### One-Shot Outline Workflow

The enriched context below (Core Packages, directory tree, dependencies, entry files) is pre-loaded. **Do not** explore by default.

1. Review the pre-loaded context above — it contains everything needed to plan the outline.
2. **Single call** to \`wiki.create_outline_draft\` with the **complete** outline: nodeKind=section folder headers + nodeKind=document pages (parentId hierarchy, all core packages covered).
3. If validationErrors are returned, fix with \`wiki.edit_outline_draft\` (prefer one repair pass).
4. Call \`wiki.submit_outline\` to lock the outline.

### Optional Fallback (only when context is clearly insufficient)

- Use \`wiki.read_tree(path, depth)\` sparingly to verify a missing path.
- Use \`subagent.delegate(profileId: "wiki-package-explorer")\` only when a core package lacks any file paths in context. Max 1 concurrent sub-agent.

Available tools:
- wiki.create_outline_draft — submit full outline in one call
- wiki.edit_outline_draft — fix validation issues
- wiki.submit_outline — lock final outline
- wiki.read_tree — optional directory browse
- subagent.delegate — optional deep exploration`;
  }

  if (role === 'document-writer') return '';

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

Build a hierarchical TOC with parentId (max depth 4). Use human-readable titles in the configured language — never use docType names (landscape, topology, etc.) as titles.

Required docType coverage (internal metadata — assign appropriate docType per entry):
- landscape: 1 per project (global entry point — tech stack, directory, concepts)
- topology: architecture connections and communication patterns
- module: one per core subsystem (deep design spec when written)
- flow: key end-to-end operations (sequence diagram + step breakdown)
- data: storage layer, schemas, lifecycle (ER diagram + schema table)

Hierarchy pattern (adapt titles to the project; parentId links children to parents):
- Use nodeKind=section for folder headers that only organize the tree (title + parentId + sortOrder — no docType, targetFiles, or keyQuestions)
- Use nodeKind=document for every page that will be written
- Example structure:
  - [section] 系统概览 (root folder)
    - [document] 项目全景 (landscape)
  - [section] 核心子系统
    - [document] 认证模块 (module)
  - [section] 关键流程
    - [document] 登录流程 (flow)

Constraints:
- Must include writable documents: 1 landscape, 1 topology, modules for all core packages
- Use parentId to nest nodes; sortOrder orders siblings at the same level
- Section nodes are never written — only fold/collapse headers in the UI
- Writable documents need targetFiles (real file paths) and keyQuestions
- title must be concise — no parenthetical elaborations`;
  }

  if (role === 'document-writer') return '';

  return `## Quality Requirements

wiki.commit_document **rejects** drafts that fail these gates — fix and resubmit.

### Global (all docTypes)
- Minimum stripped prose length per docType (headings/code fences excluded)
- Enough ## sections; each with substantive prose (not just a table or one-liner)
- At least one \`> [!NOTE|IMPORTANT|WARNING]\` callout (module/topology/flow/data)
- references[] non-empty; include startLine/endLine when citing interfaces
- claims[] with load-bearing assertions the verifier can check against source files

### Per docType minimums
| docType | ## sections | prose depth | structure |
| --- | --- | --- | --- |
| landscape | ≥2 | ≥4 long prose lines | table + dependency/list section |
| topology | ≥2 | ≥4 long prose lines | flowchart mermaid + table + callout |
| module | ≥3 | ≥8 long prose lines | code fence + Source line + table + callout + Dependencies |
| flow | ≥2 | ≥5 long prose lines | sequence mermaid + callout + step list |
| data | ≥2 | ≥4 long prose lines | erDiagram mermaid + schema table |

## Document Skeleton by Type

Copy this structure; expand with extra ## subsections when the subsystem is large.

### module
\`\`\`
# {Name} — {role}
*{subtitle}*

## Overview          → 2+ sentences: role, boundaries, integration points
## Core Interface    → typescript fence + *Source: path:lines*
## Runtime Behavior  → state table OR mermaid stateDiagram + prose on concurrency/failures
## API Surface       → table: method/event | semantics | side effects
> [!IMPORTANT]      → design decision + rejected alternative
## Dependencies      → [internal]/[external] list
> [!WARNING]         → known limits (optional)
\`\`\`

### landscape
\`\`\`
# {Project} — {positioning}
*{subtitle}*
## Tech Stack        → table
## Repository Layout → list with per-dir responsibility (not bare paths)
## Development Workflow → prose: dev/build/test commands from real package scripts
## Domain Vocabulary → table: term | meaning
\`\`\`

### topology
\`\`\`
# {System} Architecture
*{subtitle}*
## System Diagram    → flowchart mermaid (real subsystem names)
## Layer Model       → prose + table: caller → callee | protocol | sync/async
> [!IMPORTANT]      → deploy/security/perf boundaries
\`\`\`

### flow
\`\`\`
# {Flow Name} — {trigger}
*{subtitle}*
## Sequence          → sequenceDiagram mermaid
## Step Breakdown    → numbered prose (side effects, idempotency per step)
> [!WARNING]        → error/retry/branch paths
## Involved Modules → list with brief role per module
\`\`\`

### data
\`\`\`
# {Storage Layer}
*{subtitle}*
## Entity Model     → erDiagram mermaid
## Schema           → table: field | type | constraints
## Lifecycle        → prose: CRUD/archive + consistency model
\`\`\`

## Good vs Bad

BAD (README depth):
> The runtime manages agent sessions. It handles streaming and tools.

BAD (bullet dump):
> - streamRun - runs agent
> - pause - pauses
> - resume - resumes

GOOD (design-review depth):
> \`AgentLoopRuntime\` is the per-session orchestrator: \`streamRun()\` binds one LLM stream to one session and serializes tool execution through an internal run queue, so concurrent user messages cannot interleave tool side effects. \`pause()\` snapshots in-flight tool state to SQLite; \`resume()\` replays pending tool results before accepting new input. Sub-agents created via \`fork()\` inherit the parent's tool registry but get an isolated message buffer — the parent blocks until the child emits \`done\`, then merges summarized output into its own context (see Dependencies).

GOOD (callout):
> > [!IMPORTANT]
> > **单会话串行** — 同一会话禁止并发 streamRun；新消息入队等待当前 run 的 \`done\` 事件。跨会话无共享可变状态。

## Anti-Patterns (instant rejection mentally — expand before submit)
- Sections with only a table or diagram and zero prose
- Invented types/functions not in Code Context or file.read
- Mermaid with generic nodes ("Service A", "Database") instead of real package names
- Lists that duplicate directory tree without explaining responsibilities
- "It is worth noting" / "This module is responsible for" filler
- Callouts that restate the heading instead of a concrete decision or invariant

## Traceability
Every ## section should cite at least one real file in references[] or a *Source:* line. claims[].evidenceHint must point to a verifiable location.`;
}

function buildToolsGuideSegment(role: Role): string {
  if (role === 'planner') {
    return `## Rules
1. Every step must include at least one tool call
2. Submit the **full** outline in a single wiki.create_outline_draft call — do not create partial drafts
3. targetFiles must be real paths from the pre-loaded context — never invent paths
4. keyQuestions must be specific (e.g. "What state transitions does AgentLoopRuntime.streamRun have?"), not vague
5. The outline must cover all core packages with module documents; use nodeKind=section for folder headers and nodeKind=document for pages
6. Flow: create_outline_draft → edit_outline_draft (if needed) → submit_outline`;
  }
  if (role === 'document-writer') return '';
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

  if (role === 'planner') {
    segments.push(buildOutlineLanguageRequirement(locale));
  }

  if (role === 'document-writer') {
    segments.push(resolveWikiAuthoringGuide({
      projectId: input.projectId,
      workDir: input.workDir,
    }).body);
  }

  segments.push(buildIdentitySegment(role));
  segments.push(buildWorkflowSegment(role));

  if (role === 'writer' && input.outline) {
    segments.push(buildOutlineSegment(input.outline));
  }

  if (role === 'document-writer' && input.documentEntry) {
    const e = input.documentEntry;
    const questions = e.keyQuestions?.length
      ? e.keyQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
      : '(none — infer from title and target files)';
    const files = e.targetFiles?.length
      ? e.targetFiles.map(f => `- \`${f}\``).join('\n')
      : '(none — use Code Context paths)';
    segments.push(
      `## Current Document\n\n`
      + `- **Title:** ${e.title}\n`
      + `- **Type:** ${e.docType}\n`
      + `- **ID:** ${e.id}\n\n`
      + `### Key Questions (answer every one)\n${questions}\n\n`
      + `### Target Files (read with file.read if excerpts are insufficient)\n${files}`,
    );
  }

  segments.push(buildConstraintsSegment(role));
  segments.push(buildMarkdownGuide(role));
  segments.push(buildToolsGuideSegment(role));

  const ctx = buildContextSegment(input.languages, role);
  if (ctx) segments.push(ctx);

  if (role === 'planner' && input.scan && input.workDir) {
    segments.push(buildOutlineContext(input.scan, input.workDir).context);
  } else if (role === 'planner' && input.scan) {
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

  return segments.filter(segment => segment.trim().length > 0).join('\n\n');
}
