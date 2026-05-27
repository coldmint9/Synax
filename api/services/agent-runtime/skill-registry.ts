import type { AgentProfileKind, AgentSkill } from './contracts.js';
import { permissionPolicy, type PermissionPolicy } from './permission-policy.js';
import { profileService, type ProfileService } from './profile-service.js';
import { AgentNotFoundError, AgentPermissionError } from './runtime-errors.js';

type SkillSummary = Omit<AgentSkill, 'content'>;

const BUILTIN_SKILLS: AgentSkill[] = [
  {
    id: 'coord-planner',
    label: 'Coord Planner',
    description: 'Break product intent into Synapse goals, actions, and review criteria.',
    source: 'system',
    version: '1.0.0',
  appliesTo: ['planner'],
    requiredCapabilities: ['subagent.delegate'],
    permissionHints: ['write'],
    contentRef: 'system://skills/coord-planner',
    content: 'Use CoordForest context to propose goal/action structure. Ask before persisting changes.',
    status: 'available',
  },
  {
    id: 'action-executor',
    label: 'Action Executor',
    description: 'Prepare bounded execution requests and capture file-change evidence.',
    source: 'system',
    version: '1.0.0',
    appliesTo: ['executor'],
    requiredCapabilities: ['grep.search', 'diff.read', 'file.write', 'file.patch', 'subagent.delegate'],
    permissionHints: ['task', 'write'],
    contentRef: 'system://skills/action-executor',
    content: 'Read first, then perform bounded file changes through Synapse tools. Preserve session evidence.',
    status: 'available',
  },
  {
    id: 'goal-reviewer',
    label: 'Goal Reviewer',
    description: 'Review completed evidence against a goal without writing source files.',
    source: 'system',
    version: '1.0.0',
    appliesTo: ['reviewer'],
    requiredCapabilities: ['grep.search', 'diff.read'],
    permissionHints: ['none'],
    contentRef: 'system://skills/goal-reviewer',
    content: 'Compare evidence with acceptance criteria and produce a review result artifact.',
    status: 'available',
  },
  {
    id: 'code-explorer',
    label: 'Code Explorer',
    description: 'Investigate code structure through read-only file and search tools.',
    source: 'system',
    version: '1.0.0',
    appliesTo: ['explorer'],
    requiredCapabilities: ['file.glob', 'file.list', 'grep.search'],
    permissionHints: ['none'],
    contentRef: 'system://skills/code-explorer',
    content: 'Use progressively disclosed read tools. Summarize evidence and cite files.',
    status: 'available',
  },
];

function withoutContent(skill: AgentSkill): SkillSummary {
  const { content: _content, ...summary } = skill;
  return summary;
}

export class SkillRegistry {
  private readonly skills = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]));

  constructor(
    private readonly profiles: ProfileService = profileService,
    private readonly permissions: PermissionPolicy = permissionPolicy,
  ) {}

  listSummaries(input: { profileId?: string } = {}): SkillSummary[] {
    const kind = input.profileId ? this.profiles.get(input.profileId).kind : undefined;
    return [...this.skills.values()]
      .filter((skill) => skill.status === 'available')
      .filter((skill) => !kind || skill.appliesTo.includes(kind))
      .map(withoutContent);
  }

  getSummary(skillId: string): SkillSummary {
    return withoutContent(this.get(skillId));
  }

  loadFull(input: { sessionId: string; skillId: string; profileKind?: AgentProfileKind; pattern?: string }): AgentSkill {
    const skill = this.get(input.skillId);
    if (input.profileKind && !skill.appliesTo.includes(input.profileKind)) {
      throw new AgentPermissionError(`Skill ${skill.id} does not apply to ${input.profileKind}.`);
    }
    const decision = this.permissions.evaluate({
      sessionId: input.sessionId,
      category: 'skill',
      internalGate: 'skill',
      pattern: input.pattern ?? skill.id,
    });
    if (decision.action === 'deny') throw new AgentPermissionError(decision.reason);
    if (decision.action === 'ask') throw new AgentPermissionError('Skill content requires permission.', 409);
    return skill;
  }

  private get(skillId: string): AgentSkill {
    const skill = this.skills.get(skillId);
    if (!skill || skill.status !== 'available') throw new AgentNotFoundError(skillId);
    return skill;
  }
}

export const skillRegistry = new SkillRegistry();
