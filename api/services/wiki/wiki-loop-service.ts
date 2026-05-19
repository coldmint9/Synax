import { nanoid } from 'nanoid';
import { runCodeMapScan } from '../analyzer/scan.js';
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js';
import { agentEventService } from '../agent-runtime/event-service.js';
import { nowIso } from '../agent-runtime/runtime-ids.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import {
  clearSessionWorkspaceRoot,
  resolveWorkspaceRoot,
  setSessionWorkspaceRoot,
} from '../agent-runtime/tools/workspace.js';
import { logger } from '../../lib/logger.js';
import { wikiStore } from './wiki-store.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import {
  createPlannerTools,
  createWriterTools,
  createWikiTools,
  type WikiDocumentDraft,
  type WikiOutlineEntry,
  type WikiPlannerHandle,
  type WikiWriterHandle,
  type WikiToolsHandle,
} from './wiki-loop-tools.js';
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

const WIKI_PLANNER_PROMPT = `你是一位资深软件架构师。你的唯一任务是：分析代码库结构，输出一份层级化的文档目录树（outline）。

你不需要写任何文档内容，只需要规划文档结构。

## 工作流程

### Step 1：探索（3-6 步）
1. wiki.read_tree — 项目目录结构
2. wiki.read_modules — 顶层模块、语言、核心符号
3. wiki.read_code_index(kind: 'files') — 文件列表，关注 symbolCount 和 importCount 高的文件
4. wiki.read_code_index(kind: 'symbols') — 核心符号，关注 degree 高的
5. wiki.read_graph(section: 'communities') — 功能聚类
6. file.read 读取 2-3 个核心入口文件（如 index.ts、main.ts、app.ts）

### Step 2：提交目录树（1 步）
调用 wiki.submit_outline，提交层级化文档计划。

## 目录树结构要求

遵循「概要设计 → 详细设计」的标准软件设计文档格式：

Level 0（根级 — 全局视角）：
- directory_tree: 项目目录结构与模块职责
- overview: 项目概述（定位、技术栈、核心概念、部署架构）
- architecture: 系统架构（分层、模块关系、数据流）

Level 1（模块级 — 每个核心子系统）：
- module_spec: 每个核心模块的详细规格（接口、数据模型、流程）
- data_model: 核心数据模型（可选，数据密集模块）
- api: API 端点规格（可选，有对外接口的模块）

Level 2（子模块/流程级 — 深入细节）：
- module_spec: 子模块规格
- flow: 关键业务流程（含时序图）
- decision: 重要架构决策记录

约束：
- 总文档数 >= 8（目标 12-20）
- 最大嵌套深度 3 层
- 必须包含：1+ directory_tree、1+ overview、1+ architecture、3+ module_spec
- 每个条目必须指定 targetFiles（真实存在的文件路径）和 keyQuestions（具体、可回答的问题）
- sortOrder 决定同级文档的显示顺序

## 规则
1. 每一步都必须包含至少一个工具调用
2. targetFiles 必须是你在 wiki.read_code_index 中看到的真实文件路径
3. keyQuestions 必须具体（如"AgentLoopRuntime.streamRun 的状态机有哪些转换？"），不要泛泛而谈
4. 目录树应覆盖项目所有核心模块，不要遗漏重要子系统`;

const WIKI_WRITER_PROMPT_TEMPLATE = `你是一位资深技术文档工程师。你已经收到一份文档目录树（outline），你的任务是为每个文档生成详细的技术规格内容。

## 文档目录树

{OUTLINE_JSON}

## 工作策略

1. **根级文档**（directory_tree、overview、architecture）— 自己直接生成，需要全局视角
2. **模块级文档**（module_spec 等）— 使用 task.run 委派子 agent 探索后，自己格式化并提交

task.run 行为：
- 子 agent 完成前，你会阻塞等待，不会继续下一步
- 子 agent 可以递归调用 task.run 探索更深层子模块（最大深度 3 层）
- 最多同时运行 5 个子任务
- 使用 profileId: "wiki-explorer" 来委派探索任务

### 使用 task.run 委派探索：
\`\`\`
task.run({
  prompt: "分析以下文件并提供结构化技术摘要：\\n文件：{targetFiles}\\n问题：{keyQuestions}\\n\\n请用 file.read 读取每个文件，提取：1.模块概述 2.公开接口签名 3.核心数据模型 4.业务流程 5.依赖关系 6.所有引用的qualifiedName列表",
  profileId: "explorer"
})
\`\`\`

收到子 agent 返回的摘要后，格式化为 blocks 并调用 wiki.commit_document。

## 执行顺序（拓扑序）
必须按父 → 子的顺序提交。parentPlanId 指向 outline 中的 id。

## Block 类型规范
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
每个非 heading block 必须有 sourceHints，优先使用 qualifiedName（如 ClassName.methodName），其次文件路径。

## 规则
1. 每一步必须包含工具调用
2. 按拓扑序提交：父文档先于子文档
3. diagram block 提交前必须用 wiki.check_mermaid 验证
4. 不要编造不存在的 API 或类型
5. mermaid 节点标签中不要使用裸括号 ()，用引号包裹`;

function buildWriterPrompt(outline: WikiOutlineEntry[], locale: string): string {
  const outlineJson = JSON.stringify(outline, null, 2);
  let prompt = WIKI_WRITER_PROMPT_TEMPLATE.replace('{OUTLINE_JSON}', outlineJson);
  if (locale !== 'zh') {
    prompt += '\n\nIMPORTANT: Write all document content in English.';
  }
  return prompt;
}

export const wikiLoopService = {
  async generate(input: GenerateWikiInput): Promise<GenerateWikiResult> {
    const { projectId, locale = 'zh' } = input;
    const workDir = resolveWorkspaceRoot(input.workDir);

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

    const sessionIds: string[] = [];
    const registeredToolIds: string[] = [];
    const hookIds: string[] = [];

    try {
      ensureWikiProfileRegistered();

      logger.info({ projectId, workDir }, 'wiki-loop: running code map scan');
      const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });

      // ═══ Phase 1: Outline Generation ═══
      const plannerHandle = createPlannerTools(scan);
      for (const tool of plannerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      const plannerSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-planner',
        prompt: locale === 'zh' ? WIKI_PLANNER_PROMPT : `${WIKI_PLANNER_PROMPT}\n\nIMPORTANT: Write all document content in English.`,
      });
      agentRuntimeStore.updateSession(plannerSession.id, { title: 'Wiki 初始化', updatedAt: nowIso() });
      sessionIds.push(plannerSession.id);
      setSessionWorkspaceRoot(plannerSession.id, workDir);

      agentEventService.append({
        sessionId: plannerSession.id,
        type: 'progress_updated',
        summary: 'Phase 1: Generating document outline.',
        payload: { snapshotId: snapshot.id, phase: 1 },
      });

      logger.info({ projectId, sessionId: plannerSession.id }, 'wiki-loop: Phase 1 starting planner agent');
      const stream1 = agentLoopRuntime.streamRun(plannerSession.id, {});
      for await (const chunk of stream1) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Planner agent failed');
        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(plannerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Planner agent was interrupted');
        }
      }

      const outline = plannerHandle.getOutline();
      if (!outline || outline.length === 0) {
        throw new Error('Planner agent did not produce an outline');
      }

      logger.info({ projectId, outlineCount: outline.length }, 'wiki-loop: Phase 1 outline received, persisting empty documents');
      const { docIds, planIdToDocId } = await persistOutlineAsEmptyDocs(outline, snapshot.id, projectId);
      await wikiStore.updateSnapshotStatus(snapshot.id, 'outline_ready', docIds);

      // ═══ Phase 2: Content Generation ═══
      await wikiStore.updateSnapshotStatus(snapshot.id, 'writing', docIds);

      const writerHandle = createWriterTools(scan, outline);
      for (const tool of writerHandle.tools) {
        toolRegistry.register(tool);
        registeredToolIds.push(tool.id);
      }

      const commitHookId = `wiki-commit-${snapshot.id}`;
      hookIds.push(commitHookId);
      const persistedDocIds = [...docIds];

      toolRegistry.registerHook({
        id: commitHookId,
        toolId: 'wiki.commit_document',
        async afterExecute(ctx) {
          const commitResult = ctx.result.result as { ok: boolean; index?: number };
          if (!commitResult?.ok) return;
          const docs = writerHandle.getCommittedDocuments();
          const latestDoc = docs[docs.length - 1];
          if (!latestDoc) return;

          const resolvedParentId = latestDoc.parentPlanId
            ? planIdToDocId.get(latestDoc.parentPlanId) ?? null
            : null;

          const existingDocId = findExistingDocId(latestDoc, outline, planIdToDocId);
          if (existingDocId) {
            await fillDocumentContent(existingDocId, latestDoc, projectId, scan);
          } else {
            const newId = await persistSingleDocument(latestDoc, snapshot.id, projectId, scan, resolvedParentId);
            persistedDocIds.push(newId);
            const planEntry = outline.find(p => p.title === latestDoc.title && p.docType === latestDoc.docType);
            if (planEntry) planIdToDocId.set(planEntry.id, newId);
          }

          logger.info({ projectId, title: latestDoc.title }, 'wiki-loop: document content committed');
        },
      });

      const taskRunHookId = `wiki-workspace-${snapshot.id}`;
      hookIds.push(taskRunHookId);
      toolRegistry.registerHook({
        id: taskRunHookId,
        toolId: 'task.run',
        async afterExecute(ctx) {
          const result = ctx.result.result as { taskId?: string; session?: { id?: string } };
          const childId = result?.taskId ?? result?.session?.id;
          if (childId) {
            setSessionWorkspaceRoot(childId, workDir);
            sessionIds.push(childId);
          }
        },
      });

      const writerPrompt = buildWriterPrompt(outline, locale);
      const writerSession = agentSessionRuntime.create({
        projectId,
        profileId: 'wiki-writer',
        prompt: writerPrompt,
      });
      agentRuntimeStore.updateSession(writerSession.id, { title: 'Wiki 生成', updatedAt: nowIso() });
      sessionIds.push(writerSession.id);
      setSessionWorkspaceRoot(writerSession.id, workDir);

      agentEventService.append({
        sessionId: writerSession.id,
        type: 'progress_updated',
        summary: 'Phase 2: Generating document content.',
        payload: { snapshotId: snapshot.id, phase: 2 },
      });

      logger.info({ projectId, sessionId: writerSession.id }, 'wiki-loop: Phase 2 starting writer agent');
      const stream2 = agentLoopRuntime.streamRun(writerSession.id, {});
      for await (const chunk of stream2) {
        if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Writer agent failed');
        if (chunk.type === 'done') {
          const s = agentRuntimeStore.tryGetSession(writerSession.id);
          if (s && s.status === 'interrupted') throw new Error('Writer agent was interrupted');
        }
      }

      await wikiStore.updateSnapshotStatus(snapshot.id, 'ready', persistedDocIds);
      logger.info({ projectId, snapshotId: snapshot.id, docCount: persistedDocIds.length }, 'wiki-loop: generation complete');
      return { snapshotId: snapshot.id, status: 'completed' };
    } catch (err) {
      logger.error({ err, projectId, snapshotId: snapshot.id }, 'wiki-loop: generation failed');
      await failSession(sessionIds[sessionIds.length - 1], err);
      await wikiStore.updateSnapshotStatus(snapshot.id, 'failed');
      return { snapshotId: snapshot.id, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      for (const sid of sessionIds) clearSessionWorkspaceRoot(sid);
      for (const hid of hookIds) toolRegistry.unregisterHook(hid);
      for (const tid of registeredToolIds) toolRegistry.unregister(tid);
    }
  },
};

async function persistOutlineAsEmptyDocs(
  outline: WikiOutlineEntry[],
  snapshotId: string,
  projectId: string,
): Promise<{ docIds: string[]; planIdToDocId: Map<string, string> }> {
  const planIdToDocId = new Map<string, string>();
  const docIds: string[] = [];

  const sorted = topologicalSort(outline);
  for (const entry of sorted) {
    const parentId = entry.parentId ? planIdToDocId.get(entry.parentId) ?? null : null;
    const doc = await wikiStore.upsertDocument({
      snapshotId,
      projectId,
      title: entry.title,
      docType: entry.docType,
      parentId,
      sortOrder: entry.sortOrder ?? 0,
      blockIds: [],
    });
    planIdToDocId.set(entry.id, doc.id);
    docIds.push(doc.id);
  }

  return { docIds, planIdToDocId };
}

function topologicalSort(entries: WikiOutlineEntry[]): WikiOutlineEntry[] {
  const sorted: WikiOutlineEntry[] = [];
  const visited = new Set<string>();
  const visit = (entry: WikiOutlineEntry) => {
    if (visited.has(entry.id)) return;
    if (entry.parentId) {
      const parent = entries.find(e => e.id === entry.parentId);
      if (parent) visit(parent);
    }
    visited.add(entry.id);
    sorted.push(entry);
  };
  for (const entry of entries) visit(entry);
  return sorted;
}

function findExistingDocId(
  doc: WikiDocumentDraft,
  outline: WikiOutlineEntry[],
  planIdToDocId: Map<string, string>,
): string | null {
  if (doc.parentPlanId) {
    const planEntry = outline.find(p => p.id === doc.parentPlanId);
    if (planEntry) {
      const docId = planIdToDocId.get(planEntry.id);
      if (docId) return null;
    }
  }
  const match = outline.find(p => p.title === doc.title && p.docType === doc.docType);
  if (match) return planIdToDocId.get(match.id) ?? null;
  return null;
}

async function fillDocumentContent(
  docId: string,
  draft: WikiDocumentDraft,
  projectId: string,
  scan: import('../contracts/code-map.js').CodeMapScanResult,
): Promise<void> {
  const repoIndexId = scan.scanId;
  const blockIds: string[] = [];
  const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

  for (const blockDraft of draft.blocks) {
    const block = await wikiStore.upsertBlock({
      projectId,
      documentId: docId,
      blockType: blockDraft.blockType,
      content: blockDraft.content,
      contentFormat: blockDraft.contentFormat ?? 'markdown_fragment',
      confidence: blockDraft.confidence ?? 0.5,
      generatedBy: { agentRunId: docId, model: 'wiki-writer' },
    });
    blockIds.push(block.id);

    const sourceHints = blockDraft.sourceHints ?? [];
    if (sourceHints.length > 0) {
      const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
      if (links.length > 0) blockLinkMap.push({ blockId: block.id, links });
    }
  }

  await wikiStore.updateDocumentBlockIds(docId, blockIds);
  if (blockLinkMap.length > 0) {
    await wikiCoordinateService.createBindingsFromLinks(projectId, repoIndexId, blockLinkMap, scan.codeIndex);
  }
}

async function persistSingleDocument(
  draft: WikiDocumentDraft,
  snapshotId: string,
  projectId: string,
  scan: import('../contracts/code-map.js').CodeMapScanResult,
  parentId?: string | null,
): Promise<string> {
  const repoIndexId = scan.scanId;
  const doc = await wikiStore.upsertDocument({
    snapshotId,
    projectId,
    title: draft.title,
    docType: draft.docType,
    parentId: parentId ?? null,
    sortOrder: draft.sortOrder,
    blockIds: [],
  });

  const blockIds: string[] = [];
  const blockLinkMap: Array<{ blockId: string; links: import('../contracts/forest.js').SourceLink[] }> = [];

  for (const blockDraft of draft.blocks) {
    const block = await wikiStore.upsertBlock({
      projectId,
      documentId: doc.id,
      blockType: blockDraft.blockType,
      content: blockDraft.content,
      contentFormat: blockDraft.contentFormat ?? 'markdown_fragment',
      confidence: blockDraft.confidence ?? 0.5,
      generatedBy: { agentRunId: snapshotId, model: 'wiki-writer' },
    });
    blockIds.push(block.id);

    const sourceHints = blockDraft.sourceHints ?? [];
    if (sourceHints.length > 0) {
      const links = resolveSourceHints(sourceHints, scan.codeIndex, block.id);
      if (links.length > 0) blockLinkMap.push({ blockId: block.id, links });
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

async function failSession(sessionId: string | undefined, err: unknown): Promise<void> {
  if (!sessionId) return;
  const message = err instanceof Error ? err.message : String(err);
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (session && !['completed', 'failed', 'cancelled'].includes(session.status)) {
    agentRuntimeStore.updateSession(sessionId, {
      status: 'failed',
      updatedAt: nowIso(),
      completedAt: nowIso(),
      blockedReason: message,
      resultSummary: message,
      activeRunId: null,
      pendingResumeToken: null,
    });
  }
  if (session) {
    agentEventService.append({
      sessionId,
      type: 'session_failed',
      summary: message,
      payload: { error: message },
    });
  }
}
