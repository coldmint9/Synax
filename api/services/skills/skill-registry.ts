import fs from 'node:fs';
import path from 'node:path';
import type { AgentProfileKind } from '../agent-runtime/contracts.js';
import { profileService } from '../agent-runtime/profile-service.js';
import { AgentNotFoundError } from '../agent-runtime/runtime-errors.js';
import { resolveProjectWorkDir } from '../agent-runtime/tools/workspace.js';
import { scanSkillsDirectory } from './skill-scanner.js';
import { parseSkillFile } from './skill-parser.js';
import { skillIndexService } from './skill-index-service.js';
import { skillInstallService } from './skill-install-service.js';
import { skillSourceService } from './skill-source-service.js';
import { expandHome, resolveBuiltinSkillsRoot, resolveGlobalSkillsRoot } from './paths.js';
import type { ParsedSkillFile, SkillDetail, SkillListQuery, SkillSourceRecord, SkillSummary } from './types.js';

interface CollectedSkill {
  priority: number;
  skill: SkillSummary;
}

function toSummaryFromParsed(source: SkillSourceRecord, parsed: ParsedSkillFile, overrides: Partial<SkillSummary> = {}): SkillSummary {
  const sourceKind = source.type === 'builtin'
    ? 'builtin'
    : source.type === 'project'
      ? 'project'
      : source.readOnly
        ? 'remote'
        : 'local';

  return {
    id: `${source.id}/${parsed.name}`,
    name: parsed.name,
    label: parsed.label,
    description: parsed.description,
    sourceId: source.id,
    sourceKind,
    version: parsed.version,
    appliesTo: parsed.appliesTo,
    requiredCapabilities: parsed.requiredCapabilities,
    permissionHints: parsed.permissionHints,
    status: 'available',
    installPath: parsed.installPath,
    installed: sourceKind === 'local' || sourceKind === 'project' || source.id === 'local',
    ...overrides,
  };
}

function scanSource(source: SkillSourceRecord, projectId?: string): ParsedSkillFile[] {
  if (source.type === 'builtin') {
    return scanSkillsDirectory(resolveBuiltinSkillsRoot());
  }
  if (source.type === 'project') {
    if (!projectId) return [];
    return scanSkillsDirectory(path.join(resolveProjectWorkDir(projectId), '.synax', 'skills'));
  }
  if (source.type === 'local') {
    const paths = source.config.scanPaths?.length
      ? source.config.scanPaths
      : [resolveGlobalSkillsRoot()];
    const skills: ParsedSkillFile[] = [];
    for (const scanPath of paths) {
      skills.push(...scanSkillsDirectory(expandHome(scanPath)));
    }
    return skills;
  }
  return [];
}

function matchesProfile(skill: SkillSummary, profileId?: string): boolean {
  if (!profileId) return true;
  const profile = profileService.maybeGet(profileId);
  if (!profile) return false;
  return skill.appliesTo.length === 0 || skill.appliesTo.includes(profile.kind);
}

function matchesQuery(skill: SkillSummary, query?: string): boolean {
  if (!query?.trim()) return true;
  const q = query.trim().toLowerCase();
  return (
    skill.id.toLowerCase().includes(q)
    || skill.label.toLowerCase().includes(q)
    || skill.description.toLowerCase().includes(q)
    || skill.name.toLowerCase().includes(q)
    || (skill.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  );
}

function collectSummaries(input: SkillListQuery = {}): SkillSummary[] {
  skillSourceService.ensureDefaultSources();
  const sources = skillSourceService.listSources().filter((source) => source.enabled);
  const collected: CollectedSkill[] = [];
  const installedNames = new Set(skillInstallService.listInstalls().map((item) => item.name));

  for (const source of sources) {
    if (source.type === 'well-known' || source.type === 'git-index' || source.type === 'skills-sh') {
      for (const entry of skillIndexService.listCatalogEntries(source.id)) {
        collected.push({
          priority: source.priority,
          skill: {
            id: entry.id,
            name: entry.name,
            label: entry.name,
            description: entry.description,
            sourceId: source.id,
            sourceKind: 'remote',
            version: entry.version ?? '0.0.0',
            appliesTo: [],
            requiredCapabilities: [],
            permissionHints: [],
            status: 'available',
            contentDigest: entry.contentDigest,
            remoteUrl: entry.remoteUrl,
            tags: entry.tags,
            installCount: entry.installCount,
            installed: installedNames.has(entry.name),
            updateAvailable: false,
          },
        });
      }
      continue;
    }

    for (const parsed of scanSource(source, input.projectId)) {
      collected.push({
        priority: source.priority,
        skill: toSummaryFromParsed(source, parsed, {
          installed: source.id === 'local' || source.id === 'project' || installedNames.has(parsed.name),
        }),
      });
    }
  }

  for (const install of skillInstallService.listInstalls()) {
    if (install.status === 'disabled') continue;
    if (!fs.existsSync(install.installPath)) continue;
    try {
      const parsed = parseSkillFile(install.installPath);
      collected.push({
        priority: 85,
        skill: {
          id: install.id,
          name: install.name,
          label: parsed.label,
          description: parsed.description,
          sourceId: install.sourceId,
          sourceKind: 'local',
          version: parsed.version,
          appliesTo: parsed.appliesTo,
          requiredCapabilities: parsed.requiredCapabilities,
          permissionHints: parsed.permissionHints,
          status: install.status === 'update_available' ? 'update_available' : 'available',
          installPath: install.installPath,
          contentDigest: install.contentDigest,
          installed: true,
        },
      });
    } catch {
      // Skip broken installs.
    }
  }

  collected.sort((a, b) => b.priority - a.priority);
  const winners = new Map<string, SkillSummary>();
  for (const entry of collected) {
    if (!winners.has(entry.skill.name)) {
      winners.set(entry.skill.name, entry.skill);
    }
  }

  let items = [...winners.values()].filter((skill) => skill.status !== 'disabled' && skill.status !== 'invalid');

  if (input.sourceId) {
    items = items.filter((skill) => skill.sourceId === input.sourceId);
  }
  if (input.installedOnly) {
    items = items.filter((skill) => skill.installed);
  }
  items = items.filter((skill) => matchesProfile(skill, input.profileId));
  items = items.filter((skill) => matchesQuery(skill, input.q));

  items.sort((a, b) => a.label.localeCompare(b.label));

  const offset = input.offset ?? 0;
  const limit = input.limit ?? items.length;
  return items.slice(offset, offset + limit);
}

function findSummary(skillId: string, projectId?: string): SkillSummary {
  const match = collectSummaries({ projectId }).find((skill) => skill.id === skillId);
  if (!match) throw new AgentNotFoundError(skillId);
  return match;
}

export class SkillRegistry {
  listSummaries(input: SkillListQuery = {}): SkillSummary[] {
    return collectSummaries(input);
  }

  getSummary(skillId: string, projectId?: string): SkillSummary {
    return findSummary(skillId, projectId);
  }

  loadDetail(input: { skillId: string; projectId?: string }): SkillDetail {
    const summary = findSummary(input.skillId, input.projectId);
    if (!summary.installPath) throw new AgentNotFoundError(input.skillId);
    const parsed = parseSkillFile(summary.installPath);
    return {
      ...summary,
      content: parsed.content,
    };
  }
}

export const skillRegistry = new SkillRegistry();

export function resolveActiveSkillSummaries(skillIds: string[], projectId?: string): SkillSummary[] {
  return skillIds.map((skillId) => {
    try {
      return skillRegistry.getSummary(skillId, projectId);
    } catch {
      return {
        id: skillId,
        name: skillId.split('/').pop() ?? skillId,
        label: skillId,
        description: '',
        sourceId: 'unknown',
        sourceKind: 'remote',
        version: '',
        appliesTo: [] as AgentProfileKind[],
        requiredCapabilities: [],
        permissionHints: [],
        status: 'invalid',
      };
    }
  });
}
