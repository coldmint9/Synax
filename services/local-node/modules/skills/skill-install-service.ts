import fs from 'node:fs';
import path from 'node:path';
import { businessStore as store } from '../../infrastructure/persistence/business-store.js';
import { fetchSkillText, sha256Digest, verifyContentDigest } from './skill-http.js';
import { fetchSkillsShSkillContent } from './skills-sh-client.js';
import { parseSkillFile } from './skill-parser.js';
import { skillIndexService } from './skill-index-service.js';
import { resolveGlobalSkillsRoot } from './paths.js';
import type { AgentProfileKind } from '../agent-runtime/contracts.js';
import type { SkillInstallRecord, SkillInstallStatus, SkillSummary } from './types.js';

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

function nowIso(): string {
  return new Date().toISOString();
}

function assertSafeSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Skill name must match [a-z0-9-]');
  }
}

function resolveInstallDir(name: string): string {
  assertSafeSkillName(name);
  const root = resolveGlobalSkillsRoot();
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error('Invalid install path');
  }
  return target;
}

export class SkillInstallService {
  listInstalls(): SkillInstallRecord[] {
    return store.list<SkillInstallRecord>('skill-installs').sort((a,b)=>a.name.localeCompare(b.name));
  }
  getInstall(id:string):SkillInstallRecord|null {return store.get<SkillInstallRecord>('skill-installs',id) ?? null;}
  isInstalledName(name:string):boolean {return this.listInstalls().some(i=>i.name===name);}

  async install(input: { sourceId: string; name: string; version?: string; remoteUrl?: string }): Promise<SkillSummary> {
    assertSafeSkillName(input.name);
    const installDir = resolveInstallDir(input.name);
    const skillId = `local/${input.name}`;
    const existing = this.getInstall(skillId);
    // A market item with the same name is not necessarily the same skill.
    // Never overwrite source-owned files or another source's installation.
    if (fs.existsSync(installDir) && (!existing || existing.sourceId !== input.sourceId)) {
      throw new Error('A skill with this name already exists. Remove or rename it before installing from another source.');
    }
    const catalogId = `${input.sourceId}/${input.name}`;
    const entry = skillIndexService.getCatalogEntry(catalogId);
    const remoteUrl = input.remoteUrl ?? entry?.remoteUrl;

    if (!remoteUrl) {
      throw new Error(`Catalog entry not found: ${catalogId}`);
    }

    const rawContent = remoteUrl.includes('skills.sh/api/v1/skills/')
      || remoteUrl.includes('skills.sh/api/download')
      ? await fetchSkillsShSkillContent(remoteUrl)
      : await fetchSkillText(remoteUrl);
    if (!verifyContentDigest(rawContent, entry?.contentDigest)) {
      throw new Error('Skill content digest mismatch');
    }

    fs.mkdirSync(installDir, { recursive: true });
    const installPath = path.join(installDir, 'SKILL.md');
    fs.writeFileSync(installPath, rawContent, 'utf8');

    const parsed = parseSkillFile(installPath);
    const now = nowIso();
    const digest = entry?.contentDigest ?? `sha256:${sha256Digest(rawContent)}`;

    store.put('skill-installs',skillId,{
      id:skillId,sourceId:input.sourceId,name:input.name,version:parsed.version || entry?.version || input.version || '',
      label:parsed.label,description:parsed.description,installPath,contentDigest:digest,
      appliesTo:parsed.appliesTo,requiredCapabilities:parsed.requiredCapabilities,status:'installed',installedAt:existing?.installedAt ?? now,updatedAt:now,
    } satisfies SkillInstallRecord);
    await store.flush(['skill-installs']);

    const { skillRegistry } = await import('./skill-registry.js');
    return skillRegistry.getSummary(skillId, undefined, true, true);
  }

  uninstall(skillId: string): void {
    if (skillId.startsWith('synax-builtin/') || skillId.startsWith('project/')) {
      throw new Error(`Cannot uninstall skill: ${skillId}`);
    }
    const install = this.getInstall(skillId);
    if (!install) {
      throw new Error(`Installed skill not found: ${skillId}`);
    }
    if (fs.existsSync(install.installPath)) {
      const dir = path.dirname(install.installPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    store.delete('skill-installs',skillId);
  }

  setStatus(skillId: string, status: SkillInstallStatus): SkillInstallRecord {
    const install = this.getInstall(skillId);
    if (!install) throw new Error(`Installed skill not found: ${skillId}`);
    store.put('skill-installs',skillId,{...install,status,updatedAt:nowIso()});
    return this.getInstall(skillId)!;
  }

  enable(skillId: string): SkillInstallRecord {
    return this.setStatus(skillId, 'installed');
  }

  disable(skillId: string): SkillInstallRecord {
    return this.setStatus(skillId, 'disabled');
  }
}

export const skillInstallService = new SkillInstallService();
