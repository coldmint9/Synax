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
    'tools.escalate',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Wiki planner reads freely.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Wiki planner submits outline without approval.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'Planner does not delegate.' },
    { gate: 'shell', pattern: '*', action: 'deny', reason: 'Planner does not need shell.' },
  ],
  defaultSkills: [],
  maxSteps: 30,
  status: 'active',
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
  loopHints: [
    'Steps 1-6: Explore — read tree, modules, code index, graph, then read 2-3 key source files.',
    'Final step: Submit outline via wiki.submit_outline with hierarchical document plan (>= 8 docs).',
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

let registered = false;

const WIKI_PROFILE_TITLE: Record<string, string> = {
  'wiki-planner': 'Wiki 初始化',
  'wiki-writer': 'Wiki 生成',
  'wiki-explorer': 'Wiki 探索',
  'wiki-generator': 'Wiki 初始化',
};

const wikiTitleGenerator = {
  generate(ctx: { profileId: string }) {
    return WIKI_PROFILE_TITLE[ctx.profileId] ?? 'Wiki';
  },
};

export function ensureWikiProfileRegistered(): void {
  if (registered) return;
  profileService.register(wikiPlannerProfile);
  profileService.register(wikiWriterProfile);
  profileService.register(wikiExplorerProfile);
  profileService.register(wikiGeneratorProfile);
  for (const tool of createWikiExplorerTools()) {
    toolRegistry.register(tool);
  }
  registerTitleGenerator('wiki-planner', wikiTitleGenerator);
  registerTitleGenerator('wiki-writer', wikiTitleGenerator);
  registerTitleGenerator('wiki-explorer', wikiTitleGenerator);
  registerTitleGenerator('wiki-generator', wikiTitleGenerator);
  registered = true;
}
