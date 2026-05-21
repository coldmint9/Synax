import { nanoid } from 'nanoid';
import { runCodeMapScan } from '../analyzer/scan.js';
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { resolveWorkspacePath } from '../agent-runtime/tools/workspace.js';
import { logger } from '../../lib/logger.js';
import { wikiStore } from './wiki-store.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import { createWikiTools, type WikiDocumentDraft, type WikiToolsHandle } from './wiki-loop-tools.js';
import type { GenerateWikiInput, GenerateWikiResult, WikiGitState } from './wiki-snapshot-service.js';
import type { RegisteredTool } from '../agent-runtime/contracts.js';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function readGitState(workDir: string): WikiGitState {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };
  const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const headCommitSha = run('git rev-parse HEAD') || '0'.repeat(40);
  const statusOutput = run('git status --porcelain');
  const dirty = statusOutput.length > 0;
  const workingTreeHash = createHash('sha256')
    .update(statusOutput + run('git diff --binary') + run('git diff --cached --binary'))
    .digest('hex')
    .slice(0, 16);
  return { branch, headCommitSha, workingTreeHash, dirty };
}

const WIKI_SESSION_PROMPT = `你是一位资深软件架构师，负责为代码库生成**分层递进式技术规格书（Specs）**。

你的目标不是生成概述性文档，而是生成**可供开发者直接参考的详细技术规格**，包含精确的接口定义、数据模型、流程图和时序图。
文档必须组织为**多层级树状结构**，覆盖架构、模块、子模块、数据模型、API、流程等多个维度。

## 工作流程（严格按三阶段执行）

### Phase 1：探索（前 5-8 步）
按顺序执行：
1. 调用 wiki.read_tree — 获取项目目录结构，理解项目布局
2. 调用 wiki.read_modules — 了解顶层结构、语言分布、核心符号
3. 调用 wiki.read_code_index(kind: 'files') — 浏览文件列表，关注 symbolCount 和 importCount 高的文件
4. 调用 wiki.read_code_index(kind: 'symbols') — 浏览核心符号，关注 degree 高的符号
5. 调用 wiki.read_graph(section: 'communities') — 了解模块聚类和功能分组
6. 用 file.read 读取 3-5 个核心文件（入口文件、主配置、核心服务/模块）

探索完成后，调用 tools_escalate 解锁写入工具，然后进入 Phase 2。

### Phase 2：规划（1 步）
调用 wiki.submit_plan，提交**层级化**文档计划。

每个文档条目必须包含：
- id: 唯一标识（如 "root-overview", "mod-auth", "mod-auth-oauth"）
- docType: 文档类型
- title: 文档标题
- parentId: 父文档的 id（根级文档省略此字段）
- targetFiles: 需要读取的文件路径
- keyQuestions: 该文档必须回答的核心问题

层级结构要求：
- Level 0（根级）：directory_tree、overview、architecture
- Level 1（主模块/领域）：各核心模块的 module_spec、data_model、api
- Level 2（子模块/具体流程）：子模块 module_spec、flow、decision
- 最大嵌套深度：3 层
- 总文档数 >= 8（目标 10-20 个）
- 必须包含：1+ directory_tree、1+ overview、3+ module_spec
- 覆盖多个维度：架构分层、功能模块、数据模型、API 接口、关键流程

示例计划结构：
\`\`\`json
[
  { "id": "tree", "docType": "directory_tree", "title": "项目目录结构", ... },
  { "id": "overview", "docType": "overview", "title": "项目概述", ... },
  { "id": "arch", "docType": "architecture", "title": "系统架构", ... },
  { "id": "mod-agent", "docType": "module_spec", "title": "Agent Runtime", "parentId": "arch", ... },
  { "id": "mod-agent-loop", "docType": "module_spec", "title": "Loop 执行引擎", "parentId": "mod-agent", ... },
  { "id": "mod-agent-tools", "docType": "module_spec", "title": "Tool Registry", "parentId": "mod-agent", ... },
  { "id": "mod-wiki", "docType": "module_spec", "title": "Wiki 生成系统", "parentId": "arch", ... },
  { "id": "mod-wiki-flow", "docType": "flow", "title": "Wiki 生成流程", "parentId": "mod-wiki", ... },
  { "id": "data-models", "docType": "data_model", "title": "核心数据模型", "parentId": "arch", ... },
  { "id": "api-surface", "docType": "api", "title": "API 端点", "parentId": "arch", ... }
]
\`\`\`

### Phase 3：执行（剩余步数）
按**拓扑序**生成文档（父文档必须先于子文档）：
1. 先生成根级文档：directory_tree → overview → architecture
2. 再生成 Level 1 子文档（主模块 module_spec）
3. 最后生成 Level 2 子文档（子模块、flow、api 等）

对于每个文档：
- 先用 file.read 读取 targetFiles
- 调用 wiki.commit_document 提交，传入 parentPlanId 指定父文档

---

## 文档类型规范

### directory_tree 文档
展示项目目录结构和各目录的职责说明：
\`\`\`
blocks:
  1. heading: "# 项目目录结构"
  2. code_ref: 格式化的目录树（来自 wiki.read_tree 的结果）
  3. table: 各顶层目录的职责说明表（目录|职责|核心文件|说明）
\`\`\`

### overview 文档
项目整体介绍，包含技术选型和核心概念。

### module_spec 文档（核心，每个模块必须包含以下结构）
\`\`\`
blocks:
  1. heading: "# {模块名} — {一句话职责}"
  2. paragraph: "## 概述" — 模块的职责边界、设计目标（200+ 字）
  3. diagram: "## 架构图" — mermaid graph/C4 图，展示模块内部组件及其关系
  4. code_ref: "## 公开接口" — 所有导出函数/类的签名（含参数类型和返回值）
  5. table: "## 数据模型" — 核心类型的字段表（字段名|类型|说明|约束）
  6. diagram: "## 业务流程" — mermaid flowchart，描述核心业务逻辑
  7. diagram: "## 调用时序" — mermaid sequenceDiagram，描述组件间调用关系
  8. list: "## 依赖关系" — 上下游依赖说明
  9. paragraph: "## 实现细节" — 关键算法、状态管理、错误处理
\`\`\`

### architecture 文档（推荐作为根级文档）
\`\`\`
blocks:
  1. heading: "# 系统架构"
  2. diagram: "## 整体架构图" — mermaid graph TD，展示所有核心模块及其连接关系
  3. diagram: "## 分层架构" — 展示 API 层 → Service 层 → Store 层 → 外部依赖
  4. paragraph: "## 架构决策" — 为什么选择这种架构，核心约束和权衡
  5. table: "## 模块职责矩阵" — 模块名|职责|输入|输出|依赖
  6. diagram: "## 数据流" — 端到端数据流向图
\`\`\`

---

## Block 类型（blockType）
- heading: 标题，content 为 "# 标题" 格式
- paragraph: 正文段落，**至少 200 字**，包含具体技术细节
- list: 列表，每项必须有解释，不能只是一个词
- table: 表格，markdown 格式
- code_ref: 代码引用，包含实际代码片段或关键函数签名
- diagram: mermaid 图表（flowchart/sequenceDiagram/graph/classDiagram）
- decision: 决策记录
- risk: 风险记录

---

## sourceHints 溯源规范（极其重要）

sourceHints 优先使用 qualifiedName（如 \`ClassName.methodName\`），其次是文件路径。
系统会自动将符号名解析为精确的文件位置，支持 IDE 跳转。
你在 wiki.read_code_index(kind: 'symbols') 中看到的 qualifiedName 就是可用的 sourceHint 值。

规则：
- paragraph/list block: 引用具体符号名（如 \`AgentSessionRuntime.create\`、\`wikiStore.upsertDocument\`）
- code_ref block: 引用 qualifiedName（如 \`ToolRegistry.execute\`）
- diagram block: 引用涉及的所有核心符号名
- table block: 每行数据对应的类型/接口名（如 \`WikiDocType\`、\`AgentProfile\`）

---

## 质量要求
- content 字段必须是 **markdown 字符串**
- paragraph/list/table/code_ref block 的 content 至少 100 字符
- 除 heading 和 task 外，所有 block 必须有 sourceHints（真实的文件路径或符号名）
- 每个文档至少 3 个 block
- module_spec 文档必须至少 6 个 block（含 diagram）
- 不要编造不存在的 API、类型或模块
- diagram 必须是合法的 mermaid 语法
- **生成 diagram block 前，必须先用 wiki.check_mermaid 工具验证语法**。如果返回错误，修复后再次检查，直到通过才能 commit
- mermaid 节点标签中不要使用裸括号 ()，用引号包裹含特殊字符的文本（如 A["React UI (App)"]）

---

## 示例：commit_document 调用（带 parentPlanId）

\`\`\`
wiki.commit_document({
  title: "Loop 执行引擎",
  docType: "module_spec",
  parentPlanId: "mod-agent",
  sortOrder: 1,
  blocks: [
    { blockType: "heading", content: "# Loop 执行引擎 — Step-based Agent 循环" },
    {
      blockType: "paragraph",
      content: "## 概述\\n\\nLoop Runtime 是 Agent Runtime 的核心子模块...",
      sourceHints: ["AgentLoopRuntime.streamRun"],
      confidence: 0.9
    },
    ...
  ]
})
\`\`\`

---

## 极其重要的执行规则

1. **永远不要只输出文字而不调用工具。** 每一步都必须包含至少一个工具调用。如果你想说明进度，把说明放在工具调用的同一步中。纯文字回复会导致循环立即终止。
2. Phase 2 计划被接受后，**立即**在同一步调用 file.read 或 wiki.commit_document 开始 Phase 3，不要输出过渡性文字。
3. 如果某个工具调用失败（如 file.read 返回 "path is required"），忽略该错误并继续调用下一个工具。
4. 每个 wiki.commit_document 调用必须包含完整的 blocks 数组，不要分多次提交同一个文档。
5. **必须按拓扑序提交文档**：父文档先于子文档。如果子文档的 parentPlanId 对应的父文档尚未提交，该子文档的层级关系将丢失。

---

## 目标

生成至少 8 个文档（目标 10-20 个），组织为 2-3 层的树状结构：
- 根级：1 directory_tree + 1 overview + 1 architecture
- Level 1：3+ module_spec（每个核心模块）+ 可选 data_model/api
- Level 2：子模块 module_spec + flow + decision

每个 module_spec 必须包含接口签名、数据模型表、mermaid 流程图和时序图。不要泛泛而谈，要深入到函数级别的技术细节。`;


export const wikiLoopService = {
  async generate(input: GenerateWikiInput): Promise<GenerateWikiResult> {
    const { projectId, locale = 'zh' } = input;
    const workDir = resolveWorkspacePath(input.workDir);

    let gitState: WikiGitState;
    try {
      gitState = readGitState(workDir);
    } catch {
      gitState = { branch: 'unknown', headCommitSha: '0'.repeat(40), workingTreeHash: nanoid(16), dirty: false };
    }

    const snapshot = await wikiStore.createSnapshot({
      projectId,
      branch: gitState.branch,
      headCommitSha: gitState.headCommitSha,
      workingTreeHash: gitState.workingTreeHash,
      createdBy: 'agent',
    });
    await wikiStore.updateSnapshotStatus(snapshot.id, 'refreshing');

    let handle: WikiToolsHandle | null = null;
    const registeredToolIds: string[] = [];
    const hookId = `wiki-commit-${snapshot.id}`;
    const persistedDocumentIds: string[] = [];
    const planIdToDocId = new Map<string, string>();

    try {
      logger.info({ projectId, workDir }, 'wiki-loop: running code map scan');
      const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });

      handle = createWikiTools(scan);
      for (const tool of handle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      toolRegistry.registerHook({
        id: hookId,
        toolId: 'wiki.commit_document',
        async afterExecute(ctx) {
          const commitResult = ctx.result.result as { ok: boolean; index?: number };
          if (!commitResult?.ok) return;
          const docs = handle!.getCommittedDocuments();
          const latestDoc = docs[docs.length - 1];
          if (!latestDoc) return;

          const resolvedParentId = latestDoc.parentPlanId
            ? planIdToDocId.get(latestDoc.parentPlanId) ?? null
            : null;

          const docId = await persistSingleDocument(latestDoc, snapshot.id, projectId, scan, resolvedParentId);
          persistedDocumentIds.push(docId);

          const plan = handle!.getPlan();
          const planEntry = plan?.find(p => p.title === latestDoc.title && p.docType === latestDoc.docType);
          if (planEntry) {
            planIdToDocId.set(planEntry.id, docId);
          }

          logger.info({ projectId, snapshotId: snapshot.id, docId, title: latestDoc.title, parentId: resolvedParentId }, 'wiki-loop: document persisted incrementally');
        },
      });

      ensureWikiProfileRegistered();

      const prompt = locale === 'zh'
        ? WIKI_SESSION_PROMPT
        : `${WIKI_SESSION_PROMPT}\n\nIMPORTANT: Write all document content in English.`;

      const MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0 && persistedDocumentIds.length > 0) {
          await wikiStore.deleteDocumentsBySnapshot(snapshot.id);
          persistedDocumentIds.length = 0;
        }

        const session = agentSessionRuntime.create({
          projectId,
          profileId: 'wiki-generator',
          prompt,
        });

        logger.info({ projectId, sessionId: session.id, snapshotId: snapshot.id, attempt }, 'wiki-loop: starting agent loop');

        try {
          const stream = agentLoopRuntime.streamRun(session.id, {});
          for await (const chunk of stream) {
            if (chunk.type === 'run_failed') {
              throw new Error(chunk.error ?? 'Agent loop failed');
            }
          }
          break;
        } catch (retryErr) {
          const isTransient = retryErr instanceof Error &&
            (retryErr.message.includes('socket') || retryErr.message.includes('stream_read_error') || retryErr.message.includes('ECONNRESET') || retryErr.message.includes('Cannot connect'));
          if (!isTransient || attempt >= MAX_RETRIES) throw retryErr;
          logger.warn({ err: retryErr, attempt, projectId }, 'wiki-loop: transient error, retrying');
        }
      }

      const documents = handle.getCommittedDocuments();
      if (documents.length === 0) {
        throw new Error('Agent loop completed without committing any documents');
      }

      if (persistedDocumentIds.length < documents.length) {
        const remaining = documents.slice(persistedDocumentIds.length);
        for (const doc of remaining) {
          const resolvedParentId = doc.parentPlanId
            ? planIdToDocId.get(doc.parentPlanId) ?? null
            : null;
          const id = await persistSingleDocument(doc, snapshot.id, projectId, scan, resolvedParentId);
          persistedDocumentIds.push(id);

          const plan = handle.getPlan();
          const planEntry = plan?.find(p => p.title === doc.title && p.docType === doc.docType);
          if (planEntry) {
            planIdToDocId.set(planEntry.id, id);
          }
        }
      }

      await wikiStore.updateSnapshotStatus(snapshot.id, 'ready', persistedDocumentIds);
      logger.info({ projectId, snapshotId: snapshot.id, docCount: persistedDocumentIds.length }, 'wiki-loop: generation complete');

      return { snapshotId: snapshot.id, status: 'completed' };
    } catch (err) {
      logger.error({ err, projectId, snapshotId: snapshot.id }, 'wiki-loop: generation failed');
      await wikiStore.updateSnapshotStatus(snapshot.id, 'failed');
      return { snapshotId: snapshot.id, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      toolRegistry.unregisterHook(hookId);
      for (const id of registeredToolIds) {
        toolRegistry.unregister(id);
      }
    }
  },
};

async function persistSingleDocument(
  docDraft: WikiDocumentDraft,
  snapshotId: string,
  projectId: string,
  scan: import('../contracts/code-map.js').CodeMapScanResult,
  parentId?: string | null,
): Promise<string> {
  const repoIndexId = scan.scanId;

  const doc = await wikiStore.upsertDocument({
    snapshotId,
    projectId,
    title: docDraft.title,
    docType: docDraft.docType,
    parentId: parentId ?? null,
    sortOrder: docDraft.sortOrder,
    blockIds: [],
  });

  const blockIds: string[] = [];
  const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

  for (const blockDraft of docDraft.blocks) {
    const block = await wikiStore.upsertBlock({
      projectId,
      documentId: doc.id,
      blockType: blockDraft.blockType,
      content: blockDraft.content,
      contentFormat: blockDraft.contentFormat ?? 'markdown_fragment',
      confidence: blockDraft.confidence ?? 0.5,
      generatedBy: { agentRunId: snapshotId, model: 'wiki-loop-generator' },
    });
    blockIds.push(block.id);

    const sourceHints = blockDraft.sourceHints ?? [];
    if (sourceHints.length > 0) {
      const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
      if (links.length > 0) {
        blockLinkMap.push({ blockId: block.id, links });
      }
    }
  }

  await wikiStore.updateDocumentBlockIds(doc.id, blockIds);

  if (blockLinkMap.length > 0) {
    await wikiCoordinateService.createBindingsFromLinks(projectId, repoIndexId, blockLinkMap, scan.codeIndex);
  }

  return doc.id;
}

function resolveSourceHints(
  hints: string[],
  codeIndex: import('../contracts/code-map.js').CodeMapCodeIndex,
  blockId: string,
): import('../contracts/forest.js').SourceLink[] {
  const links: import('../contracts/forest.js').SourceLink[] = [];
  for (const hint of hints) {
    const sym = codeIndex.symbols.find(s => s.qualifiedName === hint || s.name === hint);
    if (sym) {
      links.push({ id: nanoid(), nodeId: blockId, anchor: { kind: 'symbol', symbolId: sym.id }, confidence: 0.8, createdBy: 'analyzer' });
      continue;
    }
    const file = codeIndex.files.find(f => f.path === hint || f.path.endsWith(hint));
    if (file) {
      links.push({ id: nanoid(), nodeId: blockId, anchor: { kind: 'file', fileId: file.id }, confidence: 0.6, createdBy: 'analyzer' });
    }
  }
  return links;
}
