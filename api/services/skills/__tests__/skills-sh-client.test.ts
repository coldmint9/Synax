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

  it('preserves every non-empty search rather than returning recommendations', () => {
    expect(resolveSkillsShSearchQuery('')).toBeUndefined();
    expect(resolveSkillsShSearchQuery('r')).toBe('r');
    expect(resolveSkillsShSearchQuery('  中文  ')).toBe('中文');
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
    expect(summary.version).toBe('');
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
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('q')).toBe('code');
  });
});


describe('search and version fidelity', () => {
  afterEach(() => vi.restoreAllMocks());
  const hit = (index: number) => ({ id: `owner/repo/skill-${index}`, slug: `skill-${index}`, name: `Skill ${index}`, source: 'owner/repo', installs: 1, sourceType: 'github', installUrl: null, url: '' });

  it('shows a version only when upstream explicitly supplies it', () => {
    expect(mapSkillsShHitToSummary('remote', { ...hit(1), version: '2.4.0' }, new Set()).version).toBe('2.4.0');
    expect(mapSkillsShHitToSummary('remote', hit(1), new Set()).version).toBe('');
  });

  it('reports the upstream minimum length instead of returning recommendations', async () => {
    await expect(listSkillsSh({ sourceId: 'remote', q: 'r', limit: 24, offset: 0, installedNames: new Set() })).rejects.toThrow('at least 2 characters');
  });

  it('sends the actual trimmed keyword and paginates search results', async () => {
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockImplementation(async (url) => new URL(url));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [hit(0), hit(1), hit(2)] })));
    const result = await listSkillsSh({ sourceId: 'remote', q: '  react  ', limit: 2, offset: 2, installedNames: new Set() });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/skills/search');
    expect(url.searchParams.get('q')).toBe('react');
    expect(result.items.map((item) => item.name)).toEqual(['skill-2']);
    expect(result.hasMore).toBe(false);
  });

  it('does not turn a search failure into recommendations', async () => {
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockImplementation(async (url) => new URL(url));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'Unavailable' }), { status: 503 }));
    await expect(listSkillsSh({ sourceId: 'remote', q: 'react', limit: 24, offset: 0, installedNames: new Set() })).rejects.toThrow('Unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles a remote offset shifted by local results without repeating rows', async () => {
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockImplementation(async (url) => new URL(url));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      const url = new URL(String(raw));
      const page = Number(url.searchParams.get('page'));
      return new Response(JSON.stringify({ data: [hit(page * 2), hit(page * 2 + 1)], pagination: { total: 10, hasMore: true } }));
    });
    const result = await listSkillsSh({ sourceId: 'remote', limit: 2, offset: 1, installedNames: new Set() });
    expect(result.items.map((item) => item.name)).toEqual(['skill-1', 'skill-2']);
  });

  it('stops at the search endpoint result cap rather than advertising empty pages', async () => {
    vi.spyOn(skillHttp, 'assertSafeSkillUrl').mockImplementation(async (url) => new URL(url));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: Array.from({ length: 200 }, (_, index) => hit(index)) })));
    const result = await listSkillsSh({ sourceId: 'remote', q: 'react', limit: 24, offset: 192, installedNames: new Set() });
    expect(result.items).toHaveLength(8);
    expect(result.hasMore).toBe(false);
  });
});
