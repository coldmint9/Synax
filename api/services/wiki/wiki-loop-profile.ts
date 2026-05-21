import type { AgentProfile } from '../agent-runtime/contracts.js';
import { profileService } from '../agent-runtime/profile-service.js';

const WIKI_LOOP_HINTS = [
  'Phase 1 (steps 1-8): Explore — read tree, modules, code index, graph, then read 3-5 key source files.',
  'Phase 2 (step 9): Plan — call wiki.submit_plan with directory_tree + overview + 3+ module_spec documents (total >= 6).',
  'Phase 3 (remaining steps): Execute — generate directory_tree first, then overview, then module_spec documents.',
  'If wiki.commit_document is rejected, fix the issues and resubmit before moving to the next document.',
  'module_spec documents must include: interfaces, data models, flowcharts, sequence diagrams, and dependencies.',
  'sourceHints should use qualifiedName (e.g. ClassName.methodName) for precise symbol-level tracing.',
];

export const wikiGeneratorProfile: AgentProfile = {
  id: 'wiki-generator',
  label: 'Wiki Generator',
  kind: 'executor',
  mode: 'primary',
  description: 'Iteratively explore a codebase and generate structured wiki documentation.',
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
  loopHints: WIKI_LOOP_HINTS,
};

let registered = false;

export function ensureWikiProfileRegistered(): void {
  if (registered) return;
  profileService.register(wikiGeneratorProfile);
  registered = true;
}
