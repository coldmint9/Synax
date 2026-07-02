import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as skillHttp from '../skill-http.js';
import {
  fetchSkillsShSkillContent,
  listSkillsSh,
  mapSkillsShHitToSummary,
  resolveSkillsShSearchQuery,
  skillsShDetailUrl,
} from '../skills-sh-client.js';

describe('skills-sh client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.SKILLS_SH_BEARER_TOKEN;
  });

  afterEach(() => {
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.SKILLS_SH_BEARER_TOKEN;
  });

  it('uses v1 search only when query is at least 2 characters', () => {
    expect(resolveSkillsShSearchQuery('')).toBeUndefined();
    expect(resolveSkillsShSearchQuery('r')).toBeUndefined();
    expect(resolveSkillsShSearchQuery('react')).toBe('react');
  });

  it('maps v1 skills into summaries with detail API urls', () => {
    const summary = mapSkillsShHitToSummary('default-remote', {
      id: 'vercel-labs/skills/find-skills',
      slug: 'find-skills',
      name: 'find-skills',
      source: 'vercel-labs/skills',
      installs: 1000,
      sourceType: 'github',
      installUrl: 'https://github.com/vercel-labs/skills',
      url: 'https://skills.sh/vercel-labs/skills/find-skills',
    }, new Set());

    expect(summary.id).toBe('default-remote/vercel-labs/skills/find-skills');
    expect(summary.name).toBe('find-skills');
    expect(summary.remoteUrl).toBe(skillsShDetailUrl('vercel-labs/skills/find-skills'));
    expect(summary.installCount).toBe(1000);
  });

  it('uses v1 leaderboard pagination totals', async () => {
    process.env.SKILLS_SH_BEARER_TOKEN = 'test-token';
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockResolvedValue(new URL('https://skills.sh/api/v1/skills'));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          id: 'vercel-labs/skills/find-skills',
          slug: 'find-skills',
          name: 'find-skills',
          source: 'vercel-labs/skills',
          installs: 1000,
          sourceType: 'github',
          installUrl: 'https://github.com/vercel-labs/skills',
          url: 'https://skills.sh/vercel-labs/skills/find-skills',
        },
      ],
      pagination: {
        page: 1,
        perPage: 24,
        total: 8420,
        hasMore: true,
      },
    }), { status: 200 }));

    const page = await listSkillsSh({
      sourceId: 'default-remote',
      view: 'all-time',
      limit: 24,
      offset: 24,
      installedNames: new Set(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/skills?'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(8420);
    expect(page.hasMore).toBe(true);
  });

  it('extracts SKILL.md from v1 detail payload', async () => {
    process.env.SKILLS_SH_BEARER_TOKEN = 'test-token';
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockResolvedValue(new URL('https://skills.sh/api/v1/skills/a/b/skill'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'a/b/skill',
      source: 'a/b',
      slug: 'skill',
      installs: 1,
      hash: null,
      files: [
        { path: 'README.md', contents: '# readme' },
        { path: 'SKILL.md', contents: '# Skill body' },
      ],
    }), { status: 200 }));

    await expect(fetchSkillsShSkillContent('vercel-labs/skills/find-skills')).resolves.toBe('# Skill body');
  });

  it('falls back to legacy search when v1 requires auth and no token is configured', async () => {
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockImplementation(async (raw) => new URL(raw));

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'authentication_required',
        message: 'auth required',
      }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        skills: [
          {
            id: 'a/b/one',
            skillId: 'one',
            name: 'one',
            installs: 1,
            source: 'a/b',
          },
        ],
        count: 1,
      }), { status: 200 }));

    const page = await listSkillsSh({
      sourceId: 'default-remote',
      q: 'code',
      limit: 24,
      offset: 0,
      installedNames: new Set(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.items[0]?.name).toBe('one');
  });
});
