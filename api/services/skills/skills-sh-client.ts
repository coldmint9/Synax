import { assertSafeSkillUrl } from './skill-http.js';
import type { SkillSummary } from './types.js';

const SKILLS_SH_BASE = 'https://skills.sh';
const SKILLS_SH_V1 = `${SKILLS_SH_BASE}/api/v1`;
const LEGACY_SEARCH_URL = `${SKILLS_SH_BASE}/api/search`;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PER_PAGE = 500;

export interface SkillsShV1Skill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: string;
  installUrl: string | null;
  url: string;
  isDuplicate?: boolean;
}

interface SkillsShListResponse {
  data: SkillsShV1Skill[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    hasMore: boolean;
  };
}

interface SkillsShSearchResponse {
  data: SkillsShV1Skill[];
  query: string;
  searchType: string;
  count: number;
  durationMs: number;
}

interface SkillsShDetailResponse {
  id: string;
  source: string;
  slug: string;
  installs: number;
  hash: string | null;
  files: Array<{ path: string; contents: string }> | null;
}

interface LegacySearchResponse {
  skills: Array<{
    id: string;
    skillId: string;
    name: string;
    installs: number;
    source: string;
  }>;
  count: number;
}

export class SkillsShApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'SkillsShApiError';
  }
}

function skillsShAuthHeaders(): Record<string, string> {
  const token = process.env.VERCEL_OIDC_TOKEN?.trim()
    || process.env.SKILLS_SH_BEARER_TOKEN?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function skillsShHasAuthToken(): boolean {
  return Boolean(skillsShAuthHeaders().Authorization);
}

export function skillsShDetailUrl(skillId: string): string {
  const normalized = skillId.replace(/^\/+/, '');
  return `${SKILLS_SH_V1}/skills/${normalized}`;
}

/** @deprecated Use skillsShDetailUrl */
export function skillsShDownloadUrl(skillPath: string): string {
  return skillsShDetailUrl(skillPath);
}

export function resolveSkillsShSearchQuery(q: string | undefined): string | undefined {
  const trimmed = q?.trim() ?? '';
  return trimmed.length >= 2 ? trimmed : undefined;
}

async function fetchSkillsShJson<T>(url: string): Promise<T> {
  const resolved = new URL(url);
  await assertSafeSkillUrl(resolved.toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(resolved.toString(), {
      headers: {
        Accept: 'application/json',
        ...skillsShAuthHeaders(),
      },
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (!response.ok) {
      throw new SkillsShApiError(
        body.message ?? `skills.sh API error (${response.status})`,
        response.status,
        body.error,
      );
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

function mapV1SkillToSummary(
  sourceId: string,
  skill: SkillsShV1Skill,
  installedNames: Set<string>,
): SkillSummary {
  return {
    id: `${sourceId}/${skill.id}`,
    name: skill.slug,
    label: skill.name,
    description: `${skill.source} · ${skill.installs.toLocaleString()} installs`,
    sourceId,
    sourceKind: 'remote',
    version: '0.0.0',
    appliesTo: [],
    requiredCapabilities: [],
    permissionHints: [],
    status: 'available',
    remoteUrl: skillsShDetailUrl(skill.id),
    installCount: skill.installs,
    installed: installedNames.has(skill.slug),
    updateAvailable: false,
  };
}

function mapLegacyHitToSummary(
  sourceId: string,
  hit: LegacySearchResponse['skills'][number],
  installedNames: Set<string>,
): SkillSummary {
  return {
    id: `${sourceId}/${hit.id}`,
    name: hit.skillId,
    label: hit.name,
    description: `${hit.source} · ${hit.installs.toLocaleString()} installs`,
    sourceId,
    sourceKind: 'remote',
    version: '0.0.0',
    appliesTo: [],
    requiredCapabilities: [],
    permissionHints: [],
    status: 'available',
    remoteUrl: skillsShDetailUrl(hit.id),
    installCount: hit.installs,
    installed: installedNames.has(hit.skillId),
    updateAvailable: false,
  };
}

async function listSkillsShV1(input: {
  sourceId: string;
  view?: string;
  q?: string;
  limit: number;
  offset: number;
  installedNames: Set<string>;
}): Promise<{ items: SkillSummary[]; total: number; hasMore: boolean; totalExact?: boolean }> {
  const limit = Math.max(1, Math.min(input.limit, MAX_PER_PAGE));
  const offset = Math.max(0, input.offset);
  const searchQuery = resolveSkillsShSearchQuery(input.q);

  if (searchQuery) {
    const fetchLimit = Math.min(Math.max(limit, offset + limit), 200);
    const url = new URL(`${SKILLS_SH_V1}/skills/search`);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('limit', String(fetchLimit));

    const response = await fetchSkillsShJson<SkillsShSearchResponse>(url.toString());
    const hits = (response.data ?? []).filter((skill) => !skill.isDuplicate);
    const pageHits = hits.slice(offset, offset + limit);
    const items = pageHits.map((hit) => mapV1SkillToSummary(input.sourceId, hit, input.installedNames));
    const hasMore = hits.length > offset + limit || (hits.length === fetchLimit && pageHits.length === limit);
    const total = hasMore
      ? offset + pageHits.length + 1
      : offset + pageHits.length;

    return { items, total, hasMore, totalExact: false };
  }

  const page = Math.floor(offset / limit);
  const url = new URL(`${SKILLS_SH_V1}/skills`);
  url.searchParams.set('view', input.view ?? 'all-time');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(limit));

  const response = await fetchSkillsShJson<SkillsShListResponse>(url.toString());
  const hits = (response.data ?? []).filter((skill) => !skill.isDuplicate);
  const items = hits.map((hit) => mapV1SkillToSummary(input.sourceId, hit, input.installedNames));
  const pagination = response.pagination ?? {
    page,
    perPage: limit,
    total: items.length,
    hasMore: false,
  };

  return {
    items,
    total: pagination.total,
    hasMore: pagination.hasMore,
    totalExact: true,
  };
}

async function listSkillsShLegacy(input: {
  sourceId: string;
  q?: string;
  defaultQuery?: string;
  limit: number;
  offset: number;
  installedNames: Set<string>;
}): Promise<{ items: SkillSummary[]; total: number; hasMore: boolean; totalExact?: boolean }> {
  const limit = Math.max(1, Math.min(input.limit, 200));
  const offset = Math.max(0, input.offset);
  const query = resolveSkillsShSearchQuery(input.q)
    ?? input.defaultQuery?.trim()
    ?? 'code';
  const fetchLimit = Math.min(offset + limit, 200);

  const url = new URL(LEGACY_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(fetchLimit));

  const response = await fetchSkillsShJson<LegacySearchResponse>(url.toString());
  const hits = response.skills ?? [];
  const pageHits = hits.slice(offset, offset + limit);
  const items = pageHits.map((hit) => mapLegacyHitToSummary(input.sourceId, hit, input.installedNames));
  const hasMore = pageHits.length === limit && hits.length === fetchLimit;

  return {
    items,
    total: hasMore ? offset + pageHits.length + 1 : offset + pageHits.length,
    hasMore,
    totalExact: false,
  };
}

export async function listSkillsSh(input: {
  sourceId: string;
  view?: string;
  defaultQuery?: string;
  q?: string;
  limit: number;
  offset: number;
  installedNames: Set<string>;
}): Promise<{ items: SkillSummary[]; total: number; hasMore: boolean; totalExact?: boolean }> {
  try {
    return await listSkillsShV1(input);
  } catch (err) {
    if (err instanceof SkillsShApiError && (err.status === 401 || err.code === 'authentication_required')) {
      if (!skillsShHasAuthToken()) {
        return listSkillsShLegacy(input);
      }
    }
    throw err;
  }
}

/** @deprecated Use listSkillsSh */
export async function searchSkillsSh(input: {
  sourceId: string;
  searchUrl?: string;
  defaultQuery?: string;
  q?: string;
  limit: number;
  offset: number;
  installedNames: Set<string>;
}): Promise<{ items: SkillSummary[]; hasMore: boolean }> {
  const result = await listSkillsSh({
    sourceId: input.sourceId,
    defaultQuery: input.defaultQuery,
    q: input.q,
    limit: input.limit,
    offset: input.offset,
    installedNames: input.installedNames,
  });
  return { items: result.items, hasMore: result.hasMore };
}

function extractSkillIdFromDetailUrl(detailUrl: string): string {
  const marker = '/api/v1/skills/';
  const idx = detailUrl.indexOf(marker);
  if (idx >= 0) {
    return detailUrl.slice(idx + marker.length);
  }
  const legacyMarker = '/api/download/';
  const legacyIdx = detailUrl.indexOf(legacyMarker);
  if (legacyIdx >= 0) {
    return detailUrl.slice(legacyIdx + legacyMarker.length);
  }
  return detailUrl.replace(/^\/+/, '');
}

export async function fetchSkillsShSkillContent(detailUrlOrSkillId: string): Promise<string> {
  const skillId = detailUrlOrSkillId.startsWith('http')
    ? extractSkillIdFromDetailUrl(detailUrlOrSkillId)
    : detailUrlOrSkillId.replace(/^\/+/, '');

  try {
    const data = await fetchSkillsShJson<SkillsShDetailResponse>(skillsShDetailUrl(skillId));
    const skillMd = data.files?.find((file) => file.path === 'SKILL.md')
      ?? data.files?.find((file) => file.path.endsWith('/SKILL.md'))
      ?? data.files?.find((file) => file.path.toLowerCase().endsWith('skill.md'));
    if (skillMd?.contents) {
      return skillMd.contents;
    }
    throw new Error('SKILL.md not found in skills.sh skill snapshot');
  } catch (err) {
    if (err instanceof SkillsShApiError && (err.status === 401 || err.code === 'authentication_required')) {
      throw new SkillsShApiError(
        'skills.sh skill download requires VERCEL_OIDC_TOKEN or SKILLS_SH_BEARER_TOKEN. See https://www.skills.sh/docs/api',
        err.status,
        err.code,
      );
    }
    throw err;
  }
}

export function mapSkillsShHitToSummary(
  sourceId: string,
  hit: SkillsShV1Skill,
  installedNames: Set<string>,
): SkillSummary {
  return mapV1SkillToSummary(sourceId, hit, installedNames);
}
