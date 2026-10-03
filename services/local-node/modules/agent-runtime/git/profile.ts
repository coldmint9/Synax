import type { AgentProfile } from '../contracts.js';
import { profileService } from '../profile-service.js';
import { toolRegistry } from '../tool-registry.js';
import { GIT_MANAGER_PROFILE_ID, GIT_MANAGER_TOOL_IDS, GIT_MR_PROVIDER_ID } from './constants.js';
import { gitMrToolProvider } from './provider.js';
import { loadGitSkill } from './skills.js';

export function ensureGitMrProfileRegistered(): void {
  let contract: string | null = null;
  try { contract = loadGitSkill('git-operation-contract').content; } catch { /* Manual MR remains available if an optional AI asset is damaged. */ }
  const profile: AgentProfile = {
    id: GIT_MANAGER_PROFILE_ID, label: 'Git Manager', kind: 'executor', mode: 'primary',
    description: 'Review one local merge request and propose conflict resolutions without publishing changes.',
    defaultThinkingMode: 'standard', allowedCapabilities: [...GIT_MANAGER_TOOL_IDS],
    permissionDefaults: [
      { gate: 'read', pattern: '*', action: 'allow', reason: 'Read only the server-bound MR.' },
      { gate: 'none', pattern: '*', action: 'allow', reason: 'Read and request clarification within this MR.' },
      { gate: 'write', pattern: '*', action: 'deny', reason: 'No workspace or branch writes.' },
      { gate: 'write', pattern: 'git.resolution.propose', action: 'allow', reason: 'Store a proposal only; never apply it.' },
      { gate: 'skill', pattern: '*', action: 'allow', reason: 'Provider restricts loading to pinned builtin Git skills.' },
      ...(['shell', 'delete', 'task', 'external_path', 'network'] as const).map(gate => ({ gate, pattern: '*', action: 'deny' as const, reason: 'Unavailable in suggestion mode.' })),
    ],
    maxSteps: 24, status: contract ? 'active' : 'disabled', mountAllTools: false, allowsSubsessions: false, toolProviderId: GIT_MR_PROVIDER_ID,
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 3 },
    loopHints: contract ? [contract, 'Available bundled skills: git-operation-contract, local-mr-review, three-way-conflict-resolution, batch-mr-orchestration, mr-verification-and-report, mr-recovery. Load these by name using skill.load.'] : [],
  };
  profileService.register(profile);
  toolRegistry.registerProvider(gitMrToolProvider);
}
