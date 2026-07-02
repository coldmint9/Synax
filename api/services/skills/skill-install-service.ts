import fs from 'node:fs';
import path from 'node:path';
import { getRawSqlite } from '../../db/index.js';
import { fetchSkillText, sha256Digest, verifyContentDigest } from './skill-http.js';
import { parseSkillFile } from './skill-parser.js';
import { skillIndexService } from './skill-index-service.js';
import { resolveGlobalSkillsRoot } from './paths.js';
import type { AgentProfileKind } from '../agent-runtime/contracts.js';
import type { SkillInstallRecord, SkillInstallStatus, SkillSummary } from './types.js';

interface InstallRow {
  id: string;
  source_id: string;
  name: string;
  version: string | null;
  label: string | null;
  description: string;
  install_path: string;
  content_digest: string | null;
  applies_to_json: string;
  required_capabilities_json: string;
  status: string;
  installed_at: string;
  updated_at: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: InstallRow): SkillInstallRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    version: row.version ?? undefined,
    label: row.label ?? undefined,
    description: row.description,
    installPath: row.install_path,
    contentDigest: row.content_digest ?? undefined,
    appliesTo: JSON.parse(row.applies_to_json) as AgentProfileKind[],
    requiredCapabilities: JSON.parse(row.required_capabilities_json) as string[],
    status: row.status as SkillInstallStatus,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
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
    const rows = getRawSqlite()
      .prepare('SELECT * FROM skill_installs ORDER BY name ASC')
      .all() as InstallRow[];
    return rows.map(rowToRecord);
  }

  getInstall(skillId: string): SkillInstallRecord | null {
    const row = getRawSqlite()
      .prepare('SELECT * FROM skill_installs WHERE id = ?')
      .get(skillId) as InstallRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  isInstalledName(name: string): boolean {
    return Boolean(getRawSqlite().prepare('SELECT 1 FROM skill_installs WHERE name = ? LIMIT 1').get(name));
  }

  async install(input: { sourceId: string; name: string; version?: string }): Promise<SkillSummary> {
    assertSafeSkillName(input.name);
    const catalogId = `${input.sourceId}/${input.name}`;
    const entry = skillIndexService.getCatalogEntry(catalogId);
    if (!entry) {
      throw new Error(`Catalog entry not found: ${catalogId}`);
    }

    const rawContent = await fetchSkillText(entry.remoteUrl);
    if (!verifyContentDigest(rawContent, entry.contentDigest)) {
      throw new Error('Skill content digest mismatch');
    }

    const installDir = resolveInstallDir(input.name);
    fs.mkdirSync(installDir, { recursive: true });
    const installPath = path.join(installDir, 'SKILL.md');
    fs.writeFileSync(installPath, rawContent, 'utf8');

    const parsed = parseSkillFile(installPath);
    const skillId = `local/${input.name}`;
    const now = nowIso();
    const digest = entry.contentDigest ?? `sha256:${sha256Digest(rawContent)}`;

    getRawSqlite().prepare(`
      INSERT INTO skill_installs (
        id, source_id, name, version, label, description, install_path, content_digest,
        applies_to_json, required_capabilities_json, status, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        version = excluded.version,
        label = excluded.label,
        description = excluded.description,
        install_path = excluded.install_path,
        content_digest = excluded.content_digest,
        applies_to_json = excluded.applies_to_json,
        required_capabilities_json = excluded.required_capabilities_json,
        status = 'installed',
        updated_at = excluded.updated_at
    `).run(
      skillId,
      input.sourceId,
      input.name,
      parsed.version,
      parsed.label,
      parsed.description,
      installPath,
      digest,
      JSON.stringify(parsed.appliesTo),
      JSON.stringify(parsed.requiredCapabilities),
      now,
      now,
    );

    const { skillRegistry } = await import('./skill-registry.js');
    return skillRegistry.getSummary(skillId);
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
    getRawSqlite().prepare('DELETE FROM skill_installs WHERE id = ?').run(skillId);
  }

  setStatus(skillId: string, status: SkillInstallStatus): SkillInstallRecord {
    const install = this.getInstall(skillId);
    if (!install) throw new Error(`Installed skill not found: ${skillId}`);
    getRawSqlite()
      .prepare('UPDATE skill_installs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), skillId);
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
