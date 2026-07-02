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
import { listSkillsSh, skillsShDetailUrl } from './skills-sh-client.js';
import { expandHome, resolveBuiltinSkillsRoot, resolveGlobalSkillsRoot } from './paths.js';
import type { ParsedSkillFile, SkillDetail, SkillListQuery, SkillListResult, SkillSourceRecord, SkillSummary } from './types.js';

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

function collectLocalSummaries(input: SkillListQuery = {}): SkillSummary[] {
  skillSourceService.ensureDefaultSources();
  const sources = skillSourceService.listSources().filter((source) => source.enabled);
  const collected: CollectedSkill[] = [];
  const installedNames = new Set(skillInstallService.listInstalls().map((item) => item.name));

  for (const source of sources) {
    if (source.type === 'well-known' || source.type === 'git-index') {
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

    if (source.type === 'skills-sh') {
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
  return items;
}

function paginateItems(items: SkillSummary[], input: SkillListQuery): SkillListResult {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? items.length;
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    total: items.length,
    hasMore: offset + page.length < items.length,
  };
}

async function listSkillsShSummaries(input: SkillListQuery, source: SkillSourceRecord): Promise<SkillListResult> {
  const installedNames = new Set(skillInstallService.listInstalls().map((item) => item.name));
  const limit = input.limit ?? 24;
  const offset = input.offset ?? 0;
  const result = await listSkillsSh({
    sourceId: source.id,
    view: source.config.view,
    defaultQuery: source.config.defaultQuery,
    q: input.q,
    limit,
    offset,
    installedNames,
  });

  let items = result.items;
  if (input.installedOnly) {
    items = items.filter((skill) => skill.installed);
  }
  items = items.filter((skill) => matchesProfile(skill, input.profileId));

  return {
    items,
    total: result.total,
    hasMore: result.hasMore,
    totalExact: result.totalExact,
  };
}

async function listWithTotal(input: SkillListQuery = {}): Promise<SkillListResult> {
  skillSourceService.ensureDefaultSources();
  const sources = skillSourceService.listSources().filter((source) => source.enabled);
  const skillsShSources = sources.filter((source) => source.type === 'skills-sh');

  if (input.sourceId) {
    const selected = sources.find((source) => source.id === input.sourceId);
    if (selected?.type === 'skills-sh') {
      return listSkillsShSummaries(input, selected);
    }
  }

  const localItems = collectLocalSummaries(input);
  const includeSkillsSh = !input.installedOnly
    && skillsShSources.length > 0
    && (!input.sourceId || skillsShSources.some((source) => source.id === input.sourceId));

  if (!includeSkillsSh) {
    return paginateItems(localItems, input);
  }

  const skillsShSource = skillsShSources.find((source) => source.id === input.sourceId)
    ?? skillsShSources[0]!;
  const limit = input.limit ?? 24;
  const offset = input.offset ?? 0;

  if (offset < localItems.length) {
    const localPage = localItems.slice(offset, Math.min(offset + limit, localItems.length));
    const remaining = limit - localPage.length;
    if (remaining <= 0) {
      return {
        items: localPage,
        total: localItems.length,
        hasMore: true,
      };
    }

    const remote = await listSkillsSh({
      sourceId: skillsShSource.id,
      view: skillsShSource.config.view,
      defaultQuery: skillsShSource.config.defaultQuery,
      q: input.q,
      limit: remaining,
      offset: 0,
      installedNames: new Set(skillInstallService.listInstalls().map((item) => item.name)),
    });

    return {
      items: [...localPage, ...remote.items],
      total: localItems.length + remote.total,
      hasMore: remote.hasMore || offset + localPage.length < localItems.length,
      totalExact: remote.totalExact,
    };
  }

  const remoteOffset = offset - localItems.length;
  const remote = await listSkillsShSummaries({
    ...input,
    sourceId: skillsShSource.id,
    offset: remoteOffset,
    limit,
  }, skillsShSource);

  return {
    items: remote.items,
    total: localItems.length + remote.total,
    hasMore: remote.hasMore,
    totalExact: remote.totalExact,
  };
}

function collectSummaries(input: SkillListQuery = {}): SkillSummary[] {
  return collectLocalSummaries(input).slice(
    input.offset ?? 0,
    (input.offset ?? 0) + (input.limit ?? Number.MAX_SAFE_INTEGER),
  );
}

function findSkillsShSummary(skillId: string): SkillSummary | null {
  const slash = skillId.indexOf('/');
  if (slash <= 0) return null;
  const sourceId = skillId.slice(0, slash);
  const skillsShPath = skillId.slice(slash + 1);
  const source = skillSourceService.getSource(sourceId);
  if (source?.type !== 'skills-sh' || !skillsShPath.includes('/')) return null;

  const name = skillsShPath.split('/').pop() ?? skillsShPath;
  const detailUrl = skillsShDetailUrl(skillsShPath);
  return {
    id: skillId,
    name,
    label: name,
    description: skillsShPath,
    sourceId,
    sourceKind: 'remote',
    version: '0.0.0',
    appliesTo: [],
    requiredCapabilities: [],
    permissionHints: [],
    status: 'available',
    remoteUrl: detailUrl,
    installed: skillInstallService.isInstalledName(name),
  };
}

function findSummary(skillId: string, projectId?: string): SkillSummary {
  const skillsSh = findSkillsShSummary(skillId);
  if (skillsSh) return skillsSh;

  const match = collectSummaries({ projectId }).find((skill) => skill.id === skillId);
  if (!match) throw new AgentNotFoundError(skillId);
  return match;
}

export class SkillRegistry {
  listSummaries(input: SkillListQuery = {}): SkillSummary[] {
    return collectSummaries(input);
  }

  async listWithTotal(input: SkillListQuery = {}): Promise<SkillListResult> {
    return listWithTotal(input);
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
