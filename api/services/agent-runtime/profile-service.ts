import type { AgentProfile, AgentProfileKind } from './contracts.js';
import { AgentNotFoundError, AgentValidationError } from './runtime-errors.js';

const allowRead = (reason = 'Project-contained read is allowed.'): { gate: 'read'; pattern: string; action: 'allow'; reason: string } => ({
  gate: 'read',
  pattern: '*',
  action: 'allow',
  reason,
});

const denyWrite = (reason: string): { gate: 'write'; pattern: string; action: 'deny'; reason: string } => ({
  gate: 'write',
  pattern: '*',
  action: 'deny',
  reason,
});

export const BUILTIN_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'planner',
    label: 'Planner',
    kind: 'planner',
    mode: 'primary',
    description: 'Turn project intent into Synapse goals and actions.',
    defaultThinkingMode: 'standard',
    allowedCapabilities: ['task.run', 'todo.manage', 'skill.load'],
    permissionDefaults: [
      allowRead(),
      { gate: 'task', pattern: '*', action: 'ask', reason: 'Planner subtask delegation requires approval.' },
      { gate: 'write', pattern: '*', action: 'ask', reason: 'Planning changes require approval.' },
    ],
    defaultSkills: ['coord-planner'],
    maxSteps: 12,
    status: 'active',
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
    loopHints: ['Prefer task decomposition and clear next actions.'],
  },
  {
    id: 'executor',
    label: 'Executor',
    kind: 'executor',
    mode: 'primary',
    description: 'Read, edit, and coordinate bounded implementation work inside Synapse.',
    defaultThinkingMode: 'standard',
    allowedCapabilities: [
      'file.glob',
      'file.list',
      'file.read',
      'grep.search',
      'diff.read',
      'file.write',
      'file.patch',
      'todo.manage',
      'task.run',
      'skill.load',
      'tools.escalate',
    ],
    permissionDefaults: [
      allowRead(),
      { gate: 'task', pattern: '*', action: 'ask', reason: 'Task delegation requires approval.' },
      { gate: 'write', pattern: '*', action: 'ask', reason: 'Writes require approval.' },
      { gate: 'shell', pattern: '*', action: 'deny', reason: 'Arbitrary shell is out of scope for v1.' },
    ],
    defaultSkills: ['action-executor'],
    maxSteps: 16,
    status: 'active',
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: true, maxParallelReadTools: 4 },
    loopHints: ['Use read tools to build context before any write.'],
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    kind: 'reviewer',
    mode: 'subagent',
    description: 'Review completed action evidence against a goal.',
    defaultThinkingMode: 'deep',
    allowedCapabilities: ['file.read', 'grep.search', 'diff.read', 'skill.load'],
    permissionDefaults: [allowRead(), denyWrite('Reviewer is read-only in v1.')],
    defaultSkills: ['goal-reviewer'],
    maxSteps: 14,
    status: 'active',
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
    loopHints: ['Focus on risks, regressions, and missing evidence.'],
    allowsSubsessions: true,
  },
  {
    id: 'explorer',
    label: 'Explorer',
    kind: 'explorer',
    mode: 'subagent',
    description: 'Fast bounded codebase investigation for another agent or user.',
    defaultThinkingMode: 'fast',
    allowedCapabilities: ['file.glob', 'file.list', 'file.read', 'grep.search', 'diff.read', 'skill.load'],
    permissionDefaults: [
      allowRead(),
      denyWrite('Explorer is read-only in v1.'),
      { gate: 'task', pattern: '*', action: 'deny', reason: 'Explorer cannot delegate more tasks in v1.' },
      { gate: 'shell', pattern: '*', action: 'deny', reason: 'Explorer does not need shell access.' },
    ],
    defaultSkills: ['code-explorer'],
    maxSteps: 8,
    status: 'active',
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 4 },
    loopHints: ['Use read-only tools and summarize concrete evidence.'],
    allowsSubsessions: true,
  },
];

export class ProfileService {
  private readonly profiles = new Map(BUILTIN_AGENT_PROFILES.map((profile) => [profile.id, profile]));

  list(): AgentProfile[] {
    return [...this.profiles.values()].filter((profile) => profile.status === 'active');
  }

  get(profileId: string): AgentProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new AgentNotFoundError(profileId);
    return profile;
  }

  tryGet(profileId: string): AgentProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) return this.profiles.get('executor')!;
    return profile;
  }

  assertCanStart(profileId: string, input: { parentSessionId?: string | null } = {}): AgentProfile {
    const profile = this.get(profileId);
    if (profile.status !== 'active') throw new AgentValidationError(`Agent profile ${profileId} is disabled.`);
    if (input.parentSessionId && profile.mode !== 'subagent') {
      throw new AgentValidationError('Child sessions must use a subagent profile.');
    }
    return profile;
  }

  register(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile);
  }

  isReadOnlyProfile(kind: AgentProfileKind): boolean {
    return kind === 'reviewer' || kind === 'explorer';
  }
}

export const profileService = new ProfileService();
