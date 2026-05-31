import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { WikiOutlineEntry } from './wiki-loop-tools.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  fileCount: number;
  languageDistribution: Record<string, number>;
  moduleCount: number;
  hasMonorepo: boolean;
  estimatedComplexity: 'small' | 'medium' | 'large';
}

export interface WikiPromptInput {
  role: 'planner' | 'writer' | 'document-writer';
  projectMeta: ProjectMeta;
  locale: 'zh' | 'en';
  outline?: WikiOutlineEntry[];
  continuation?: { completedTitles: string[]; remainingCount: number };
  preloadedContext?: string;
  documentContext?: string;
  documentEntry?: WikiOutlineEntry;
}

// ── Extract project metadata from scan ───────────────────────────────────────

export function extractProjectMeta(scan: CodeMapScanResult): ProjectMeta {
  const fileCount = scan.codeIndex.stats.fileCount;
  const langDist: Record<string, number> = {};
  if (scan.moduleMap?.languages) {
    for (const lang of scan.moduleMap.languages) {
      langDist[lang.language] = lang.fileCount;
    }
  }
  const moduleCount = scan.moduleMap?.topDirs.length ?? 0;
  const hasMonorepo = scan.moduleMap?.topDirs.some(
    d => d.path.includes('packages/') || d.path.includes('apps/')
  ) ?? false;

  let estimatedComplexity: ProjectMeta['estimatedComplexity'];
  if (fileCount < 50 || moduleCount < 5) estimatedComplexity = 'small';
  else if (fileCount > 300 || moduleCount > 15) estimatedComplexity = 'large';
  else estimatedComplexity = 'medium';

  return { fileCount, languageDistribution: langDist, moduleCount, hasMonorepo, estimatedComplexity };
}

// ── Segment builders ─────────────────────────────────────────────────────────

type Locale = 'zh' | 'en';
type Role = 'planner' | 'writer' | 'document-writer';

function buildIdentitySegment(role: Role, locale: Locale): string {
  if (locale === 'en') {
    if (role === 'planner') {
      return 'You are a senior software architect. Your sole task is: analyze the codebase structure and output a hierarchical document outline.\n\nYou do not need to write any document content — only plan the document structure.';
    }
    if (role === 'document-writer') {
      return 'You are a senior technical documentation engineer. Your task is to generate detailed technical specification content for the specified document based on the provided code context. All necessary code information has been pre-loaded — write directly based on the context.';
    }
    return 'You are a senior technical documentation engineer. You have received a document outline, and your task is to generate detailed technical specification content for each document.';
  }
  if (role === 'planner') {
    return '你是一位资深软件架构师。你的唯一任务是：分析代码库结构，输出一份层级化的文档目录树（outline）。\n\n你不需要写任何文档内容，只需要规划文档结构。';
  }
  if (role === 'document-writer') {
    return '你是一位资深技术文档工程师。你的任务是根据提供的代码上下文，为指定文档生成详细的技术规格内容。所有需要的代码信息已预先提供，直接基于上下文撰写即可。';
  }
  return '你是一位资深技术文档工程师。你已经收到一份文档目录树（outline），你的任务是为每个文档生成详细的技术规格内容。';
}

function buildWorkflowSegment(role: Role, locale: Locale): string {
  if (locale === 'en') return buildWorkflowSegmentEn(role);
  return buildWorkflowSegmentZh(role);
}

function buildWorkflowSegmentEn(role: Role): string {
  if (role === 'planner') {
    return `## Workflow

### Step 1: Global Overview (2-3 steps)
1. wiki.read_modules — top-level modules, languages, core symbols
2. wiki.read_tree — project directory structure
3. wiki.read_code_index(kind: 'files') — file list, focus on files with high symbolCount and importCount

### Step 2: Deep Exploration as Needed
Decide exploration depth and steps based on project complexity:
- file.list(path) — deeper file discovery for interesting subdirectories
- file.glob(pattern) — pattern-match specific file types
- grep.search(query, path) — search for key concepts, interfaces, core class names
- file.read — read core entry files and discovered key files
- wiki.read_code_index(kind: 'symbols') — core symbols, focus on high degree, callCount, callerCount
- wiki.read_graph(section: 'communities') — functional clusters (optional)
- wiki.read_call_graph(symbolName, direction) — query call relationships of core symbols
- wiki.impact_analysis(target, targetType) — analyze impact scope of key modules

Large projects should explore more modules; small projects can finish quickly.

### Step 3: Submit Outline
Call wiki.submit_outline to submit the hierarchical document plan.`;
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

### Using subagent.delegate for exploration:
\`\`\`
subagent.delegate({
  prompt: "Analyze the following files and provide a structured technical summary:\\nFiles: {targetFiles}\\nQuestions: {keyQuestions}\\n\\nUse file.read to read each file and extract: 1. Module overview 2. Public interface signatures 3. Core data models 4. Business flows 5. Dependencies 6. All referenced qualifiedName list",
  profileId: "explorer"
})
\`\`\`

After receiving the sub-agent's summary, format into blocks and call wiki.commit_document.

## Execution Order (topological)
Must submit in parent → child order. parentPlanId points to the id in the outline.`;
}

function buildWorkflowSegmentZh(role: Role): string {
  if (role === 'planner') {
    return `## 工作流程

### Step 1：全局概览（2-3 步）
1. wiki.read_modules — 顶层模块、语言、核心符号
2. wiki.read_tree — 项目目录结构
3. wiki.read_code_index(kind: 'files') — 文件列表，关注 symbolCount 和 importCount 高的文件

### Step 2：按需深入探索
根据项目复杂度自行决定探索深度和步数：
- file.list(path) — 对感兴趣的子目录做更深层的文件发现
- file.glob(pattern) — 按模式匹配查找特定类型的文件
- grep.search(query, path) — 搜索关键概念、接口、核心类名
- file.read — 读取核心入口文件和发现的关键文件
- wiki.read_code_index(kind: 'symbols') — 核心符号，关注 degree、callCount、callerCount 高的
- wiki.read_graph(section: 'communities') — 功能聚类（可选）
- wiki.read_call_graph(symbolName, direction) — 查询核心 symbol 的调用关系，理解模块间耦合
- wiki.impact_analysis(target, targetType) — 分析关键模块的影响范围，辅助文档边界划分

大型项目应探索更多模块，小型项目可以快速完成。

### Step 3：提交目录树
调用 wiki.submit_outline，提交层级化文档计划。`;
  }

  if (role === 'document-writer') {
    return `## 工作流程

1. 阅读下方提供的代码上下文（文件、符号、依赖关系）
2. 根据 keyQuestions 组织内容结构
3. 生成所有 blocks（至少 6 个 block）
4. 调用 wiki.commit_document 提交文档

无需调用代码探索工具，所有必要信息已在上下文中提供。`;
  }

  return `## 工作策略

逐个生成文档，每次聚焦一个 document 的所有 blocks。

1. **根级文档**（directory_tree、overview、architecture）— 自己直接生成，需要全局视角
2. **模块级文档**（module_spec 等）— 委派通用 explorer 子代理探索代码，收到摘要后格式化并提交

subagent.delegate 行为：
- 使用 profileId: "explorer"（通用代码探索）
- 子 agent 完成前，你会阻塞等待
- 最多同时运行 5 个子任务

### 使用 subagent.delegate 委派探索：
\`\`\`
subagent.delegate({
  prompt: "分析以下文件并提供结构化技术摘要：\\n文件：{targetFiles}\\n问题：{keyQuestions}\\n\\n请用 file.read 读取每个文件，提取：1.模块概述 2.公开接口签名 3.核心数据模型 4.业务流程 5.依赖关系 6.所有引用的qualifiedName列表",
  profileId: "explorer"
})
\`\`\`

收到子 agent 返回的摘要后，格式化为 blocks 并调用 wiki.commit_document。

## 执行顺序（拓扑序）
必须按父 → 子的顺序逐个提交。parentPlanId 指向 outline 中的 id。`;
}

function buildConstraintsSegment(role: Role, meta: ProjectMeta, locale: Locale): string {
  if (role === 'planner') {
    const { estimatedComplexity, hasMonorepo, moduleCount } = meta;
    const maxDepth = moduleCount > 15 ? 4 : 3;

    if (locale === 'en') {
      const docRange = estimatedComplexity === 'small'
        ? 'Total documents >= 6 (target 8-12)'
        : estimatedComplexity === 'large'
          ? 'Total documents >= 12 (target 20-30)'
          : 'Total documents >= 8 (target 12-20)';
      const monorepoRule = hasMonorepo ? '\n- At least one module_spec per package/app' : '';
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
- decision: Important architectural decision records

Constraints:
- ${docRange}
- Maximum nesting depth: ${maxDepth} levels
- Must include: 1+ directory_tree, 1+ overview, 1+ architecture, 3+ module_spec${monorepoRule}
- Each entry must specify targetFiles (real file paths) and keyQuestions (specific, answerable questions)
- sortOrder determines display order among siblings
- title must be concise — no parenthetical elaborations`;
    }

    const docRange = estimatedComplexity === 'small'
      ? '总文档数 >= 6（目标 8-12）'
      : estimatedComplexity === 'large'
        ? '总文档数 >= 12（目标 20-30）'
        : '总文档数 >= 8（目标 12-20）';
    const monorepoRule = hasMonorepo ? '\n- 每个 package/app 至少一个 module_spec' : '';

    return `## 目录树结构要求

遵循「概要设计 → 详细设计」的标准软件设计文档格式：

Level 0（根级 — 全局视角）：
- directory_tree: 项目目录结构与模块职责
- overview: 项目概述
- architecture: 系统架构

Level 1（模块级 — 每个核心子系统）：
- module_spec: 每个核心模块的详细规格
- data_model: 核心数据模型（可选，数据密集模块）
- api: API 端点规格（可选，有对外接口的模块）

Level 2（子模块/流程级 — 深入细节）：
- module_spec: 子模块规格
- flow: 关键业务流程
- decision: 重要架构决策记录

约束：
- ${docRange}
- 最大嵌套深度 ${maxDepth} 层
- 必须包含：1+ directory_tree、1+ overview、1+ architecture、3+ module_spec${monorepoRule}
- 每个条目必须指定 targetFiles（真实存在的文件路径）和 keyQuestions（具体、可回答的问题）
- sortOrder 决定同级文档的显示顺序
- title 必须简洁，禁止使用括号补充说明（错误示例："系统架构（分层、模块关系、数据流）"，正确示例："系统架构"）`;
  }

  if (locale === 'en') {
    return `## Block Type Specifications
- heading: "# Title" format
- paragraph: At least 200 words, include specific technical details
- list: Each item with explanation
- table: Markdown table (Field|Type|Description|Constraints)
- code_ref: Key function signatures or code snippets
- diagram: Mermaid diagrams (must validate with wiki.check_mermaid before submitting)
- decision: Decision records
- risk: Risk records

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

  return `## Block 类型规范
- heading: "# 标题" 格式
- paragraph: 至少 200 字，包含具体技术细节
- list: 每项有解释
- table: markdown 表格（字段|类型|说明|约束）
- code_ref: 关键函数签名或代码片段
- diagram: mermaid 图表（提交前必须用 wiki.check_mermaid 验证）
- decision: 决策记录
- risk: 风险记录

## module_spec 文档必须包含（至少 6 个 block）：
1. heading: "# {模块名} — {一句话职责}"
2. paragraph: 概述（200+ 字，职责边界、设计目标）
3. code_ref: 公开接口签名
4. table: 数据模型字段表
5. diagram: 业务流程图（mermaid flowchart）
6. list: 依赖关系

## sourceHints 溯源规范（极其重要）
每个非 heading block 必须有 sourceHints，优先使用 qualifiedName（如 ClassName.methodName），其次文件路径。`;
}

function buildToolsGuideSegment(role: Role, locale: Locale): string {
  if (locale === 'en') {
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

  if (role === 'planner') {
    return `## 规则
1. 每一步都必须包含至少一个工具调用
2. targetFiles 必须是你在 wiki.read_code_index 中看到的真实文件路径
3. keyQuestions 必须具体（如"AgentLoopRuntime.streamRun 的状态机有哪些转换？"），不要泛泛而谈
4. 目录树应覆盖项目所有核心模块，不要遗漏重要子系统`;
  }

  if (role === 'document-writer') {
    return `## 规则
1. 直接基于提供的代码上下文撰写，不要编造不存在的 API 或类型
2. diagram block 提交前必须用 wiki.check_mermaid 验证
3. mermaid 节点标签中不要使用裸括号 ()，用引号包裹
4. 每个非 heading block 必须有 sourceHints`;
  }

  return `## 规则
1. 每一步必须包含工具调用
2. 按拓扑序提交：父文档先于子文档
3. diagram block 提交前必须用 wiki.check_mermaid 验证
4. 不要编造不存在的 API 或类型
5. mermaid 节点标签中不要使用裸括号 ()，用引号包裹`;
}

function buildContextSegment(meta: ProjectMeta, locale: Locale): string {
  const langs = Object.entries(meta.languageDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang, count]) => `${lang}(${count})`)
    .join(', ');

  if (locale === 'en') {
    const lines = [
      `## Project Overview`,
      `- Total files: ${meta.fileCount}`,
      `- Primary languages: ${langs || 'unknown'}`,
      `- Top-level modules: ${meta.moduleCount}`,
      `- Estimated complexity: ${meta.estimatedComplexity}`,
    ];
    if (meta.hasMonorepo) {
      lines.push('- Structure: monorepo (multi-package)');
    }
    return lines.join('\n');
  }

  const lines = [
    `## 项目概况`,
    `- 文件总数: ${meta.fileCount}`,
    `- 主要语言: ${langs || '未知'}`,
    `- 顶层模块数: ${meta.moduleCount}`,
    `- 复杂度评估: ${meta.estimatedComplexity}`,
  ];
  if (meta.hasMonorepo) {
    lines.push('- 结构: monorepo（多包）');
  }
  return lines.join('\n');
}

function buildContinuationSegment(ctx: { completedTitles: string[]; remainingCount: number }, locale: Locale): string {
  const completed = ctx.completedTitles.map(t => `  - ✓ ${t}`).join('\n');

  if (locale === 'en') {
    return `## Continuation Context

The following documents are already completed — do not regenerate:
${completed}

Remaining documents to generate: ${ctx.remainingCount}
Only generate content for incomplete documents.`;
  }

  return `## 续写上下文

以下文档已完成，无需重复生成：
${completed}

剩余待生成文档数: ${ctx.remainingCount}
请只为未完成的文档生成内容。`;
}

function buildPreloadedContextSegment(context: string, locale: Locale): string {
  if (locale === 'en') {
    return `## Pre-loaded Exploration Results (from Planner phase)

The following codebase information was explored during the Planner phase. You can use this data directly without repeating the same tool calls:

${context}`;
  }

  return `## 预加载探索结果（来自 Planner 阶段）

以下是 Planner 阶段已探索的代码库信息，你可以直接使用这些数据，无需重复调用相同的工具：

${context}`;
}

function buildOutlineSegment(outline: WikiOutlineEntry[], locale: Locale): string {
  const title = locale === 'en' ? '## Document Outline' : '## 文档目录树';
  return `${title}\n\n${JSON.stringify(outline, null, 2)}`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

export function buildWikiPrompt(input: WikiPromptInput): string {
  const { locale } = input;
  const segments: string[] = [];

  segments.push(buildIdentitySegment(input.role, locale));
  segments.push(buildWorkflowSegment(input.role, locale));

  if (input.role === 'writer' && input.outline) {
    segments.push(buildOutlineSegment(input.outline, locale));
  }

  if (input.role === 'document-writer' && input.documentEntry) {
    if (locale === 'en') {
      segments.push(`## Current Document\n\n- Title: ${input.documentEntry.title}\n- Type: ${input.documentEntry.docType}\n- ID: ${input.documentEntry.id}`);
    } else {
      segments.push(`## 当前文档\n\n- 标题: ${input.documentEntry.title}\n- 类型: ${input.documentEntry.docType}\n- ID: ${input.documentEntry.id}`);
    }
  }

  segments.push(buildConstraintsSegment(input.role, input.projectMeta, locale));
  segments.push(buildToolsGuideSegment(input.role, locale));
  segments.push(buildContextSegment(input.projectMeta, locale));

  if (input.documentContext) {
    const header = locale === 'en' ? '## Code Context' : '## 代码上下文';
    segments.push(`${header}\n\n${input.documentContext}`);
  }

  if (input.preloadedContext) {
    segments.push(buildPreloadedContextSegment(input.preloadedContext, locale));
  }

  if (input.continuation) {
    segments.push(buildContinuationSegment(input.continuation, locale));
  }

  return segments.join('\n\n');
}
