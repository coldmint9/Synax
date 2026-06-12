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
    return `You are a senior software architect writing internal design specifications (RFC / ADR / architecture review quality).

Your reader is an engineer who must understand system design, trade-offs, invariants, and extension points **without reading source code first**.

Depth bar (non-negotiable):
- Every ## section needs at least one substantive prose paragraph (3+ sentences, concrete mechanisms — not a single line or bullet dump).
- Answer every keyQuestion from the outline explicitly; if a question has no answer in code, say what is missing and cite what you checked.
- Prefer **showing** interfaces (fenced code), state machines (tables + mermaid), and runtime behavior over naming files.
- Each major claim must be traceable: inline backticks, a Source line after code fences, and entries in references[].

Writing style:
- Lead with the conclusion, then mechanism, then constraints / rejected alternatives.
- Explain WHY the design exists, HOW it behaves at runtime, WHAT breaks if misused.
- Use inline \`code\` for types, functions, config keys, enum values, and state names.
- Design decisions, invariants, and caveats belong in GitHub-style callouts (\`> [!IMPORTANT]\` / \`> [!WARNING]\`) — never one throwaway sentence.
- Tables compare structured data (states, API surface, config keys). Lists inventory dependencies or ordered steps — not substitutes for prose.
- Mermaid diagrams use **real module/type names** from Code Context; validate with wiki.check_mermaid before submit.

Output: a single markdown string via wiki.commit_document (markdown + references[] + claims[]).`;
  }
  return `You are a technical documentation engineer. Generate document content as markdown for the specified documents in the outline.

Writing constraints: be precise, no filler, no AI-speak, no repeating titles. Lead with conclusions. Use ## headings, tables, mermaid diagrams, and code fences as appropriate.`;
}

function buildMarkdownGuide(role: Role): string {
  if (role === 'planner') return '';
  if (role === 'document-writer') {
    return `## Markdown Syntax (use exactly these patterns)

### Document opening
\`\`\`markdown
# ModuleName — One-Phrase Role

*One-line subtitle: what this subsystem does and its primary integration points.*

## Overview
First paragraph states the architectural role in one sentence, then expands mechanism...
\`\`\`
Do **not** repeat the # title as the first sentence of Overview.

### Callouts (design decisions, caveats, concurrency model)
\`\`\`markdown
> [!NOTE]
> **并发模型** — sub-agent 通过 \`fork()\` 创建，共享父级 tool registry 但维护独立上下文。

> [!IMPORTANT]
> **关键不变量** — 单会话内 streamRun 串行化；跨会话完全隔离。

> [!WARNING]
> **已知限制** — 当 sub-agent tree 深度 > 3 时 context 合并可能溢出 token 预算。
\`\`\`
Use at least one callout per module / topology / flow document. Labels: NOTE (context), IMPORTANT (invariants/decisions), WARNING (limits/footguns).

### Interface / signature blocks
Show real types from code — never invent APIs. After each primary interface fence, add a Source line:
\`\`\`markdown
\`\`\`typescript
interface AgentLoopRuntime {
  streamRun(input: RunInput): AsyncGenerator<StreamEvent>;
  pause(): Promise<PauseSnapshot>;
}
\`\`\`
*Source: \`api/services/agent-runtime/contracts.ts:42-71\`*

### Tables (state machines, API surface, config)
\`\`\`markdown
| State | Description | Transitions |
| --- | --- | --- |
| \`idle\` | 等待输入 | \`→ streaming\` on \`streamRun()\` |
\`\`\`

### Mermaid diagrams
\`\`\`markdown
## State Machine

\`\`\`mermaid
stateDiagram-v2
  idle --> streaming: streamRun()
  streaming --> tool_executing: tool_call
\`\`\`
\`\`\`
Put a ## heading before each diagram. Use sequenceDiagram for flows, flowchart for topology, erDiagram for data.

### Expandable detail sections (optional but encouraged for module)
\`\`\`markdown
<details>
<summary>Gate 决策矩阵</summary>

| mutability | internalGate | 行为 |
| --- | --- | --- |
| \`read\` | \`none\` | 直接执行 |

</details>
\`\`\`

### Dependency inventory
\`\`\`markdown
## Dependencies

- **[internal]** \`llm-runtime/stream\` — 底层 LLM provider 流式调用
- **[external]** \`ai (vercel)\` — streamText / generateObject 封装
\`\`\`

### Cross-references
Link other wiki concepts with markdown anchors: \`see [Context Compression](#context-compression)\` and matching \`## Context Compression\` heading.

### references[] (commit payload, not in markdown body)
Mirror every Source line and major section in references[]:
\`{ "filePath": "api/.../contracts.ts", "startLine": 42, "endLine": 71, "symbol": "AgentLoopRuntime" }\``;
  }
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

1. Read **Key Questions** and **Target Files** for this document — they define what "done" means
2. Study Code Context (excerpts, symbols, imports) as primary evidence; use file.read on targetFiles for gaps
3. Draft an outline: # title + italic subtitle → ## sections mapped 1:1 to keyQuestions
4. Write each section: opening prose (3+ sentences) → evidence (code/table/diagram) → callout if there's a decision or caveat
5. Add Dependencies section with [internal]/[external] tags where applicable
6. Self-check against Quality Requirements below (length, ## count, callouts, prose depth, tables/diagrams)
7. wiki.check_mermaid on every diagram; fix syntax before submit
8. wiki.commit_document with markdown, references[] (with line numbers where possible), claims[] (load-bearing facts)

If you cannot verify a fact from code, do not assert it — mark as unknown or omit from claims.`;
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
- module: one per core subsystem (deep design spec when written)
- flow: key end-to-end operations (sequence diagram + step breakdown)
- data: storage layer, schemas, lifecycle (ER diagram + schema table)

Constraints:
- Must include: 1 landscape, 1 topology, modules for all core packages
- Documents are FLAT — no parentId nesting. Use xref cross-references instead.
- Each entry must specify targetFiles (real file paths) and keyQuestions
- title must be concise — no parenthetical elaborations`;
  }

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
2. Use the 3-step flow: wiki.create_outline_draft -> wiki.edit_outline_draft -> wiki.submit_outline
3. targetFiles must be real file paths — check wiki.read_tree to see which files exist
4. keyQuestions must be specific (e.g. "What state transitions does AgentLoopRuntime.streamRun have?"), not vague
5. The outline should cover all core modules — do not omit important subsystems`;
  }
  if (role === 'document-writer') {
    return `## Pre-submit Checklist
1. Every keyQuestion has a dedicated answer in prose (cite section name in your head — no orphan questions)
2. # title + *subtitle* present; Overview does not repeat the title verbatim
3. At least one \`> [!IMPORTANT]\` or \`> [!WARNING]\` with a **bold label** and concrete mechanism
4. Primary interface shown in a fenced code block + \`*Source: path:lines*\`
5. Each ## section has ≥1 prose paragraph before any table/diagram (except pure diagram sections)
6. Mermaid validated; node labels quoted if they contain parentheses
7. references[] mirrors Source lines; claims[] has ≥2 load-bearing items for module docs
8. On rejection: read error list, expand the thinnest sections first, add missing callout/table/diagram`;
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
