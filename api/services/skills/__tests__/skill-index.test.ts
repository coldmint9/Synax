import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as skillHttp from '../skill-http.js';
import { skillIndexService } from '../skill-index-service.js';
import { skillSourceService, PRESET_REMOTE_SOURCES } from '../skill-source-service.js';
import { getRawSqlite } from '../../../db/index.js';

describe('skillIndexService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    skillSourceService.ensureDefaultSources();
  });

  it('syncs a git-index source into catalog entries', async () => {
    const source = skillSourceService.createSource({
      id: 'demo-git',
      label: 'Demo Git',
      type: 'git-index',
      config: {
        repo: 'vercel-labs/agent-skills',
        ref: 'main',
        indexPath: 'skills-index.json',
      },
    });

    vi.spyOn(skillHttp, 'fetchSkillJson').mockResolvedValue({
      skills: [
        {
          name: 'demo-skill',
          summary: 'Demo skill summary',
          url: 'https://raw.githubusercontent.com/vercel-labs/agent-skills/main/demo-skill/SKILL.md',
          digest: 'sha256:abc',
        },
      ],
    });

    const synced = await skillIndexService.syncSource(source.id);
    expect(synced).toBe(1);

    const entry = skillIndexService.getCatalogEntry('demo-git/demo-skill');
    expect(entry?.description).toBe('Demo skill summary');
    expect(entry?.remoteUrl).toContain('demo-skill/SKILL.md');

    getRawSqlite().prepare('DELETE FROM skill_catalog_entries WHERE source_id = ?').run('demo-git');
    skillSourceService.deleteSource('demo-git');
  });

  it('syncs everything-skills search.json array format', async () => {
    vi.spyOn(skillHttp, 'fetchSkillJson').mockResolvedValue([
      {
        name: 'demo-skill',
        title: 'Demo Skill',
        description: 'A demo skill',
        path: '00-meta/demo-skill/SKILL.md',
        tags: ['demo'],
      },
    ]);

    const synced = await skillIndexService.syncSource('cn-everything-skills');
    expect(synced).toBe(1);

    const entry = skillIndexService.getCatalogEntry('cn-everything-skills/demo-skill');
    expect(entry?.description).toBe('A demo skill');
    expect(entry?.remoteUrl).toContain('/00-meta/demo-skill/SKILL.md');

    getRawSqlite().prepare('DELETE FROM skill_catalog_entries WHERE source_id = ?').run('cn-everything-skills');
  });

  it('seeds preset domestic remote sources', () => {
    const ids = skillSourceService.listSources().map((source) => source.id);
    for (const preset of PRESET_REMOTE_SOURCES) {
      expect(ids).toContain(preset.id);
    }
  });
});
