import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getRawSqlite } from '../../../db/index.js';
import { skillsRoutes } from '../../../routes/skills.js';
import { skillRegistry } from '../skill-registry.js';
import { skillSourceService } from '../skill-source-service.js';
import { skillInstallService } from '../skill-install-service.js';
import { skillPreferences } from '../skill-preferences.js';
import { parseSkillFile } from '../skill-parser.js';
import * as skillHttp from '../skill-http.js';

const app = new Hono().route('/skills', skillsRoutes);
let root: string;
let installPath: string;

beforeEach(() => {
  skillSourceService.ensureDefaultSources();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-skill-management-'));
  fs.mkdirSync(path.join(root, 'management-test'));
  installPath = path.join(root, 'management-test', 'SKILL.md');
  fs.writeFileSync(
    installPath,
    '---\nname: management-test\ndescription: Searchable demo for tests\n---\nSkill body',
  );
  skillSourceService.createSource({
    id: 'management-test-source',
    label: 'Test',
    type: 'local',
    priority: 90,
    config: { scanPaths: [root] },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  getRawSqlite()
    .prepare("DELETE FROM skill_installs WHERE name = 'management-test'")
    .run();
  getRawSqlite().prepare('DELETE FROM skill_preferences').run();
  skillSourceService.deleteSource('management-test-source');
  fs.rmSync(root, { recursive: true, force: true });
});

function insertInstall() {
  getRawSqlite()
    .prepare(
      `INSERT INTO skill_installs
    (id, source_id, name, description, install_path, status, installed_at, updated_at)
    VALUES ('local/management-test', 'default-remote', 'management-test', 'Demo', ?, 'installed', '', '')`,
    )
    .run(installPath);
}

describe('skill management', () => {
  it('does not fabricate a version for unversioned files', () => {
    expect(parseSkillFile(installPath).version).toBe('');
    fs.writeFileSync(
      installPath,
      '---\nname: management-test\ndescription: demo\nversion: 2.3.1\n---\nBody',
    );
    expect(parseSkillFile(installPath).version).toBe('2.3.1');
    fs.writeFileSync(
      installPath,
      '---\nname: management-test\ndescription: demo\nmetadata:\n  version: 3.2.0\n---\nBody',
    );
    expect(parseSkillFile(installPath).version).toBe('3.2.0');
  });

  it('keeps disabled source-owned files visible in management but blocks runtime loading', async () => {
    const id = 'management-test-source/management-test';
    const response = await app.request(
      `/skills/${encodeURIComponent(id)}/disable`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    expect(fs.existsSync(installPath)).toBe(true);
    expect(skillRegistry.listSummaries().some((s) => s.id === id)).toBe(false);
    expect(() => skillRegistry.loadDetail({ skillId: id })).toThrow();
    const list = await app.request(
      '/skills?includeDisabled=true&installedOnly=true&q=SEARCHABLE',
    );
    expect((await list.json()).items).toEqual([
      expect.objectContaining({ id, status: 'disabled', installed: true }),
    ]);
    expect(
      (
        await app.request(`/skills/${encodeURIComponent(id)}/enable`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(skillRegistry.getSummary(id).status).toBe('available');
  });

  it('does not let a scanned file bypass a disabled managed installation', () => {
    insertInstall();
    skillInstallService.disable('local/management-test');
    expect(skillRegistry.listSummaries({ q: 'management-test' })).toEqual([]);
    const skill = skillRegistry.listSummaries({
      q: 'management-test',
      includeDisabled: true,
    })[0]!;
    expect(skill).toMatchObject({
      status: 'disabled',
      installationId: 'local/management-test',
      installed: true,
    });
    skillRegistry.setEnabled(skill.id, true);
    expect(skillRegistry.listSummaries({ q: 'management-test' })).toHaveLength(
      1,
    );
  });

  it('allows toggling built-in skills without allowing uninstall', () => {
    const id = 'synax-builtin/synax-explore';
    expect(skillRegistry.getSummary(id).installed).toBe(true);
    skillRegistry.setEnabled(id, false);
    expect(skillRegistry.getSummary(id, undefined, true).status).toBe(
      'disabled',
    );
    expect(() => skillRegistry.getSummary(id)).toThrow();
    expect(() => skillInstallService.uninstall(id)).toThrow('Cannot uninstall');
    skillRegistry.setEnabled(id, true);
    expect(skillRegistry.getSummary(id).status).toBe('available');
  });

  it('scopes project preferences without disabling other projects', () => {
    skillPreferences.setEnabled('project/example', false, 'project-a');
    expect(
      skillPreferences.disabledIds('project-a').has('project/example'),
    ).toBe(true);
    expect(
      skillPreferences.disabledIds('project-b').has('project/example'),
    ).toBe(false);
  });

  it('uninstalls only the managed files and record', () => {
    insertInstall();
    skillInstallService.uninstall('local/management-test');
    expect(fs.existsSync(installPath)).toBe(false);
    expect(skillInstallService.getInstall('local/management-test')).toBeNull();
  });

  it('installs unversioned remote content as enabled without a made-up version', async () => {
    vi.spyOn(skillHttp, 'fetchSkillText').mockResolvedValue(
      '---\nname: management-test\ndescription: installed demo\n---\nBody',
    );
    const installed = await skillInstallService.install({
      sourceId: 'default-remote',
      name: 'management-test',
      remoteUrl: 'https://example.com/SKILL.md',
    });
    // A higher-priority source can share a name, but the canonical install id must still resolve.
    expect(installed.status).toBe('available');
    expect(installed.version).toBe('');
    skillInstallService.uninstall('local/management-test');
  });
});
