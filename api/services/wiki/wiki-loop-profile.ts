import type { AgentProfile } from '../agent-runtime/contracts.js';
import { profileService } from '../agent-runtime/profile-service.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { registerTitleGenerator } from '../agent-runtime/session-title-service.js';
import { createWikiExplorerTools } from './wiki-loop-tools.js';

export const wikiPlannerProfile: AgentProfile = {
  id: 'wiki-planner',
  label: 'Wiki Planner',
  kind: 'planner',
  mode: 'primary',
  description: 'Explore a codebase and generate a hierarchical document outline for wiki generation.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'grep.search',
    'wiki.read_code_index',
    'wiki.read_graph',
    'wiki.read_modules',
    'wiki.read_tree',
    'wiki.submit_outline',
    'subagent.delegate',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki planner reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Wiki planner submits outline without approval.' },
    { gate: 'task', pattern: '*', action: 'allow', reason: 'Planner delegates exploration to sub-agents.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Planner does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 40,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
  loopHints: [
    'Step 1: High-level scan — read tree, modules, code index, and graph to understand overall structure.',
    'Step 2: For each [需拆分] package in the baseline, delegate exploration to a subagent via subagent.delegate(profileId: "explorer"). Give each subagent a specific prompt: which directory to explore, what questions to answer. Launch up to 5 concurrently.',
    'Step 3: After all subagents return, synthesize their summaries. Read any remaining files yourself if gaps remain.',
    'Final step: Submit outline via wiki.submit_outline. Ensure every [需拆分] package has >= 2 covering docs with children.',
  ],
};

export const wikiWriterProfile: AgentProfile = {
  id: 'wiki-writer',
  label: 'Wiki Writer',
  kind: 'executor',
  mode: 'primary',
  description: 'Generate wiki document content by delegating to sub-agents based on a pre-built outline.',
  defaultThinkingMode: 'standard',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'grep.search',
    'wiki.read_code_index',
    'wiki.read_graph',
    'wiki.read_modules',
    'wiki.read_tree',
    'wiki.commit_document',
    'wiki.check_mermaid',
    'subagent.delegate',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki writer reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Wiki writer commits documents without approval.' },
    { gate: 'task', pattern: '*', action: 'allow', reason: 'Wiki writer delegates to sub-agents.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Wiki writer does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 60,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
  doomLoopThreshold: 6,
  loopHints: [
    'Generate root-level documents (directory_tree, overview, architecture) yourself — they need global context.',
    'For module_spec documents, use subagent.delegate(profileId: "wiki-explorer") to gather existing wiki context when needed.',
    'Always commit documents in topological order: parents before children.',
    'sourceHints should use qualifiedName (e.g. ClassName.methodName) for precise symbol-level tracing.',
  ],
};

export const wikiExplorerProfile: AgentProfile = {
  id: 'wiki-explorer',
  label: 'Wiki Explorer',
  kind: 'explorer',
  mode: 'subagent',
  description: 'Search and read generated wiki documents to provide design context.',
  defaultThinkingMode: 'fast',
  allowedCapabilities: [
    'wiki.list_documents',
    'wiki.read_document',
    'wiki.search_content',
    'grep.search',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki explorer reads freely.' },
    { gate: 'write', pattern: '*', action: 'deny', reason: 'Wiki explorer is read-only.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Wiki explorer cannot delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Wiki explorer does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 6,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'List documents first to understand available wiki content.',
    'Read specific documents relevant to the query.',
    'Return a focused summary answering the parent agent\'s question.',
  ],
};

export const wikiDocumentWriterProfile: AgentProfile = {
  id: 'wiki-document-writer',
  label: 'Wiki Document Writer',
  kind: 'executor',
  mode: 'primary',
  description: 'Generate content for a single wiki document using pre-built code context.',
  defaultThinkingMode: 'standard',
  allowedCapabilities: [
    'file.read',
    'file.list',
    'file.glob',
    'grep.search',
    'wiki.commit_document',
    'wiki.check_mermaid',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Document writer reads context.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Document writer commits without approval.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Document writer does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Document writer does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 12,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Read source files referenced in targetFiles to verify facts before writing.',
    'Use wiki.check_mermaid before committing any diagram block.',
    'Call wiki.commit_document once all blocks are ready. Include claims for every factual assertion.',
  ],
};

export const wikiGeneratorProfile: AgentProfile = {
  id: 'wiki-generator',
  label: 'Wiki Generator (Legacy)',
  kind: 'executor',
  mode: 'primary',
  description: 'Legacy single-phase wiki generator. Use wiki-planner + wiki-writer instead.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'file.glob',
    'file.list',
    'file.read',
    'grep.search',
    'wiki.read_code_index',
    'wiki.read_graph',
    'wiki.read_modules',
    'wiki.read_tree',
    'wiki.submit_plan',
    'wiki.commit_document',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki generation reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Wiki generation commits documents without approval.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Wiki generator does not delegate subtasks.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Wiki generator does not need shell access.' },
  ],
  defaultSkills: [],
  maxSteps: 50,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [],
};

export const wikiVerifierProfile: AgentProfile = {
  id: 'wiki-verifier',
  label: 'Wiki Verifier',
  kind: 'reviewer',
  mode: 'subagent',
  description: 'Adversarially verify claims made by wiki writers by reading source code.',
  defaultThinkingMode: 'standard',
  allowedCapabilities: [
    'file.read',
    'file.list',
    'file.glob',
    'grep.search',
    'diff.read',
    'wiki.submit_verdict',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Verifier reads source freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Verifier submits verdict.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Verifier does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Verifier does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 6,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Verify each claim by reading actual source files. Call wiki.submit_verdict once per claim.',
    'If you cannot find supporting evidence for a claim, default to refuted=true.',
    'Be efficient: read only the files relevant to the claims, then submit all verdicts.',
  ],
};

let registered = false;

const WIKI_PROFILE_TITLE: Record<string, Record<'zh' | 'en', string>> = {
  'wiki-planner': { zh: 'Wiki 初始化', en: 'Wiki Initialization' },
  'wiki-writer': { zh: 'Wiki 生成', en: 'Wiki Generation' },
  'wiki-document-writer': { zh: 'Wiki 文档生成', en: 'Wiki Document Generation' },
  'wiki-explorer': { zh: 'Wiki 探索', en: 'Wiki Exploration' },
  'wiki-verifier': { zh: 'Wiki 验证', en: 'Wiki Verification' },
  'wiki-generator': { zh: 'Wiki 初始化', en: 'Wiki Initialization' },
};

export function getWikiProfileTitle(profileId: string, locale: 'zh' | 'en' = 'zh'): string {
  return WIKI_PROFILE_TITLE[profileId]?.[locale] ?? 'Wiki';
}

const wikiTitleGenerator = {
  generate(ctx: { profileId: string }) {
    return WIKI_PROFILE_TITLE[ctx.profileId]?.zh ?? 'Wiki';
  },
};

export function ensureWikiProfileRegistered(): void {
  if (registered) return;
  profileService.register(wikiPlannerProfile);
  profileService.register(wikiWriterProfile);
  profileService.register(wikiDocumentWriterProfile);
  profileService.register(wikiExplorerProfile);
  profileService.register(wikiVerifierProfile);
  profileService.register(wikiGeneratorProfile);
  for (const tool of createWikiExplorerTools()) {
    toolRegistry.register(tool);
  }
  registerTitleGenerator('wiki-planner', wikiTitleGenerator);
  registerTitleGenerator('wiki-writer', wikiTitleGenerator);
  registerTitleGenerator('wiki-document-writer', wikiTitleGenerator);
  registerTitleGenerator('wiki-explorer', wikiTitleGenerator);
  registerTitleGenerator('wiki-verifier', wikiTitleGenerator);
  registerTitleGenerator('wiki-generator', wikiTitleGenerator);
  registered = true;
}
