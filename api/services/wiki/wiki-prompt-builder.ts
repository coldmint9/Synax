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
  role: 'planner' | 'writer';
  projectMeta: ProjectMeta;
  locale: 'zh' | 'en';
  outline?: WikiOutlineEntry[];
  continuation?: { completedTitles: string[]; remainingCount: number };
  preloadedContext?: string;
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

function buildIdentitySegment(role: 'planner' | 'writer'): string {
  if (role === 'planner') {
    return '你是一位资深软件架构师。你的唯一任务是：分析代码库结构，输出一份层级化的文档目录树（outline）。\n\n你不需要写任何文档内容，只需要规划文档结构。';
  }
  return '你是一位资深技术文档工程师。你已经收到一份文档目录树（outline），你的任务是为每个文档生成详细的技术规格内容。';
}

function buildWorkflowSegment(role: 'planner' | 'writer'): string {
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
- wiki.read_code_index(kind: 'symbols') — 核心符号，关注 degree 高的
- wiki.read_graph(section: 'communities') — 功能聚类（可选）

大型项目应探索更多模块，小型项目可以快速完成。

### Step 3：提交目录树
调用 wiki.submit_outline，提交层级化文档计划。`;
  }

  return `## 工作策略

1. **根级文档**（directory_tree、overview、architecture）— 自己直接生成，需要全局视角
2. **模块级文档**（module_spec 等）— 使用 subagent.delegate 委派子 agent 探索后，自己格式化并提交

subagent.delegate 行为：
- 子 agent 完成前，你会阻塞等待，不会继续下一步
- 子 agent 可以递归调用 subagent.delegate 探索更深层子模块（最大深度 3 层）
- 最多同时运行 5 个子任务
- 使用 profileId: "wiki-explorer" 来委派探索任务

### 使用 subagent.delegate 委派探索：
\`\`\`
subagent.delegate({
  prompt: "分析以下文件并提供结构化技术摘要：\\n文件：{targetFiles}\\n问题：{keyQuestions}\\n\\n请用 file.read 读取每个文件，提取：1.模块概述 2.公开接口签名 3.核心数据模型 4.业务流程 5.依赖关系 6.所有引用的qualifiedName列表",
  profileId: "explorer"
})
\`\`\`

收到子 agent 返回的摘要后，格式化为 blocks 并调用 wiki.commit_document。

## 执行顺序（拓扑序）
必须按父 → 子的顺序提交。parentPlanId 指向 outline 中的 id。`;
}

function buildConstraintsSegment(role: 'planner' | 'writer', meta: ProjectMeta): string {
  if (role === 'planner') {
    const { estimatedComplexity, hasMonorepo, moduleCount } = meta;
    const docRange = estimatedComplexity === 'small'
      ? '总文档数 >= 6（目标 8-12）'
      : estimatedComplexity === 'large'
        ? '总文档数 >= 12（目标 20-30）'
        : '总文档数 >= 8（目标 12-20）';
    const maxDepth = moduleCount > 15 ? 4 : 3;
    const monorepoRule = hasMonorepo
      ? '\n- 每个 package/app 至少一个 module_spec'
      : '';

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

function buildToolsGuideSegment(role: 'planner' | 'writer'): string {
  if (role === 'planner') {
    return `## 规则
1. 每一步都必须包含至少一个工具调用
2. targetFiles 必须是你在 wiki.read_code_index 中看到的真实文件路径
3. keyQuestions 必须具体（如"AgentLoopRuntime.streamRun 的状态机有哪些转换？"），不要泛泛而谈
4. 目录树应覆盖项目所有核心模块，不要遗漏重要子系统`;
  }

  return `## 规则
1. 每一步必须包含工具调用
2. 按拓扑序提交：父文档先于子文档
3. diagram block 提交前必须用 wiki.check_mermaid 验证
4. 不要编造不存在的 API 或类型
5. mermaid 节点标签中不要使用裸括号 ()，用引号包裹`;
}

function buildContextSegment(meta: ProjectMeta): string {
  const langs = Object.entries(meta.languageDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang, count]) => `${lang}(${count})`)
    .join(', ');

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

function buildLocaleSegment(locale: 'zh' | 'en'): string {
  if (locale === 'en') {
    return '## Language\nWrite ALL document content, titles, and descriptions in English. Use English for all output.';
  }
  return '';
}

function buildContinuationSegment(ctx: { completedTitles: string[]; remainingCount: number }): string {
  const completed = ctx.completedTitles.map(t => `  - ✓ ${t}`).join('\n');
  return `## 续写上下文

以下文档已完成，无需重复生成：
${completed}

剩余待生成文档数: ${ctx.remainingCount}
请只为未完成的文档生成内容。`;
}

function buildPreloadedContextSegment(context: string): string {
  return `## 预加载探索结果（来自 Planner 阶段）

以下是 Planner 阶段已探索的代码库信息，你可以直接使用这些数据，无需重复调用相同的工具：

${context}`;
}


function buildOutlineSegment(outline: WikiOutlineEntry[]): string {
  return `## 文档目录树\n\n${JSON.stringify(outline, null, 2)}`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

export function buildWikiPrompt(input: WikiPromptInput): string {
  const segments: string[] = [];

  segments.push(buildIdentitySegment(input.role));
  segments.push(buildWorkflowSegment(input.role));

  if (input.role === 'writer' && input.outline) {
    segments.push(buildOutlineSegment(input.outline));
  }

  segments.push(buildConstraintsSegment(input.role, input.projectMeta));
  segments.push(buildToolsGuideSegment(input.role));
  segments.push(buildContextSegment(input.projectMeta));

  const localeSegment = buildLocaleSegment(input.locale);
  if (localeSegment) segments.push(localeSegment);

  if (input.preloadedContext) {
    segments.push(buildPreloadedContextSegment(input.preloadedContext));
  }

  if (input.continuation) {
    segments.push(buildContinuationSegment(input.continuation));
  }

  return segments.join('\n\n');
}
