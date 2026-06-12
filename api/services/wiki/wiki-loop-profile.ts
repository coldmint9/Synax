import type { AgentProfile, FallbackDisclosureConfig } from '../agent-runtime/contracts.js';
import { profileService } from '../agent-runtime/profile-service.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { registerTitleGenerator } from '../agent-runtime/session-title-service.js';
import { createWikiExplorerTools } from './wiki-loop-tools.js';
import { wikiSessionToolProvider } from './wiki-session-tool-provider.js';

/** Shared fallback config: file/grep tools hidden until bash errors 4 times in a row. */
const WIKI_FALLBACK_DISCLOSURE: FallbackDisclosureConfig = {
  fallbackToolIds: ['file.read', 'file.list', 'file.glob', 'grep.search', 'diff.read'],
  trackedToolId: 'bash',
  consecutiveErrorThreshold: 4,
};

export const wikiPlannerProfile: AgentProfile = {
  id: 'wiki-planner',
  label: 'Wiki Planner',
  kind: 'planner',
  mode: 'primary',
  description: 'Explore a codebase and generate a hierarchical document outline for wiki generation.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'bash',
    'wiki.read_tree',
    'wiki.submit_outline',
    'wiki.create_outline_draft',
    'wiki.edit_outline_draft',
    'subagent.delegate',
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki planner reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Wiki planner submits outline without approval.' },
    { gate: 'task', pattern: '*', action: 'allow', reason: 'Planner delegates exploration to sub-agents.' },
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Planner uses bash for file exploration.' },
  ],
  defaultSkills: [],
  maxSteps: 40,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
  fallbackDisclosure: WIKI_FALLBACK_DISCLOSURE,
  toolProviderId: 'wiki-session-tools',
  loopHints: [
    'Step 1: Review the directory tree and package baseline in the system prompt.',
    'Step 2: For packages you need to understand deeper, use wiki.read_tree(path, depth) to explore subdirectories.',
    'Step 3: For core packages that need detailed analysis, delegate to subagent.delegate(profileId: "wiki-package-explorer"). Max 3 concurrent sub-agents.',
    'Step 4: Synthesize all findings and use the 3-step outline flow: create_outline_draft -> edit_outline_draft -> submit_outline.',
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
    'bash',
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
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Wiki writer uses bash for file exploration.' },
  ],
  defaultSkills: [],
  maxSteps: 60,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
  doomLoopThreshold: 6,
  fallbackDisclosure: WIKI_FALLBACK_DISCLOSURE,
  toolProviderId: 'wiki-session-tools',
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

export const wikiPackageExplorerProfile: AgentProfile = {
  id: 'wiki-package-explorer',
  label: 'Wiki Package Explorer',
  kind: 'explorer',
  mode: 'subagent',
  description: 'Explore a code package using read_tree for directory structure and bash for file content.',
  defaultThinkingMode: 'fast',
  allowedCapabilities: [
    'bash',
    'wiki.read_tree',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Read-only explorer.' },
    { gate: 'write', pattern: '*', action: 'deny', reason: 'Explorer is read-only.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Explorer does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Explorer uses bash for file reading.' },
  ],
  defaultSkills: [],
  maxSteps: 10,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 3 },
  loopHints: [
    'Use wiki.read_tree to explore the package directory structure.',
    'Use bash (cat/head) to read key source files.',
    'Return a focused summary: responsibility, main types, dependencies, data flows.',
  ],
};

export const wikiDocumentWriterProfile: AgentProfile = {
  id: 'wiki-document-writer',
  label: 'Wiki Document Writer',
  kind: 'executor',
  mode: 'primary',
  description: 'Generate design-spec quality content for a single wiki document using pre-built code context.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'bash',
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
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Document writer uses bash for file reading.' },
  ],
  defaultSkills: [],
  maxSteps: 20,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  fallbackDisclosure: WIKI_FALLBACK_DISCLOSURE,
  toolProviderId: 'wiki-session-tools',
  loopHints: [
    'Study Source Excerpts in the prompt before writing; use file.read when behavior is still unclear.',
    'Structure documents with level-2 headings and mixed block types — not prose-only walls of text.',
    'Use wiki.check_mermaid before committing any diagram block.',
    'If wiki.commit_document rejects the draft, expand thin prose and add missing tables/diagrams/callouts before resubmitting.',
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
    'bash',
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
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Wiki generator uses bash for file exploration.' },
  ],
  defaultSkills: [],
  maxSteps: 50,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  fallbackDisclosure: WIKI_FALLBACK_DISCLOSURE,
  toolProviderId: 'wiki-session-tools',
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
    'bash',
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
    { gate: 'shell', pattern: '*', action: 'allow', reason: 'Verifier uses bash for source verification.' },
  ],
  defaultSkills: [],
  maxSteps: 6,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  fallbackDisclosure: WIKI_FALLBACK_DISCLOSURE,
  toolProviderId: 'wiki-session-tools',
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
  'wiki-package-explorer': { zh: 'Wiki 包探索', en: 'Wiki Package Exploration' },
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
  profileService.register(wikiPackageExplorerProfile);
  profileService.register(wikiGeneratorProfile);
  for (const tool of createWikiExplorerTools()) {
    toolRegistry.register(tool);
  }
  toolRegistry.registerProvider(wikiSessionToolProvider);
  registerTitleGenerator('wiki-planner', wikiTitleGenerator);
  registerTitleGenerator('wiki-writer', wikiTitleGenerator);
  registerTitleGenerator('wiki-document-writer', wikiTitleGenerator);
  registerTitleGenerator('wiki-explorer', wikiTitleGenerator);
  registerTitleGenerator('wiki-verifier', wikiTitleGenerator);
  registerTitleGenerator('wiki-package-explorer', wikiTitleGenerator);
  registerTitleGenerator('wiki-generator', wikiTitleGenerator);
  registered = true;
}
