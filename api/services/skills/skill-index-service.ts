import { getRawSqlite } from '../../db/index.js';
import { parseSkillMarkdown } from './skill-parser.js';
import { fetchSkillJson, fetchSkillText } from './skill-http.js';
import { skillSourceService } from './skill-source-service.js';
import type { SkillCatalogEntry, SkillSourceRecord } from './types.js';

interface WellKnownIndex {
  skills?: Array<{
    name: string;
    description?: string;
    version?: string;
    url: string;
    digest?: string;
  }>;
}

interface GitIndex {
  skills?: Array<{
    id?: string;
    name?: string;
    summary?: string;
    description?: string;
    version?: string;
    url: string;
    digest?: string;
    tags?: string[];
  }>;
}

interface EverythingSearchEntry {
  name: string;
  title?: string;
  description?: string;
  path: string;
  tags?: string[];
}

interface GitHubContentEntry {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

interface CatalogRow {
  id: string;
  source_id: string;
  name: string;
  description: string;
  version: string | null;
  remote_url: string;
  content_digest: string | null;
  install_count: number | null;
  tags_json: string;
  indexed_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToEntry(row: CatalogRow): SkillCatalogEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    description: row.description,
    version: row.version ?? undefined,
    remoteUrl: row.remote_url,
    contentDigest: row.content_digest ?? undefined,
    installCount: row.install_count ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    indexedAt: row.indexed_at,
  };
}

function normalizeRepo(repo: string): string {
  return repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function resolveRepoContentBase(source: SkillSourceRecord): string {
  const repo = source.config.repo;
  if (!repo) throw new Error('git-index source requires config.repo');
  const ref = source.config.ref ?? 'main';
  return `https://raw.githubusercontent.com/${normalizeRepo(repo)}/${ref}/`;
}

function resolveIndexUrl(source: SkillSourceRecord): string {
  if (source.config.url) return source.config.url;
  if (source.type === 'well-known') {
    throw new Error('well-known source requires config.url');
  }
  if (source.type === 'git-index') {
    const repo = source.config.repo;
    if (!repo) throw new Error('git-index source requires config.repo');
    const ref = source.config.ref ?? 'main';
    const indexPath = source.config.indexPath ?? 'skills-index.json';
    return `https://raw.githubusercontent.com/${normalizeRepo(repo)}/${ref}/${indexPath}`;
  }
  throw new Error(`Source type ${source.type} does not support remote sync`);
}

function resolveContentBaseUrl(source: SkillSourceRecord, indexUrl: string): string {
  if (source.config.contentBase === 'repo-root') {
    return resolveRepoContentBase(source);
  }
  const url = new URL(indexUrl);
  if (indexUrl.endsWith('.json')) {
    return `${url.origin}${url.pathname.replace(/\/[^/]+$/, '/')}`;
  }
  return `${url.origin}/`;
}

function resolveWellKnownBaseUrl(indexUrl: string): string {
  const url = new URL(indexUrl);
  if (indexUrl.endsWith('.json')) {
    return `${url.origin}${url.pathname.replace(/\/[^/]+$/, '/')}`;
  }
  return `${url.origin}/`;
}

export class SkillIndexService {
  listCatalogEntries(sourceId?: string): SkillCatalogEntry[] {
    skillSourceService.ensureDefaultSources();
    const rows = sourceId
      ? getRawSqlite()
        .prepare('SELECT * FROM skill_catalog_entries WHERE source_id = ? ORDER BY name ASC')
        .all(sourceId) as CatalogRow[]
      : getRawSqlite()
        .prepare('SELECT * FROM skill_catalog_entries ORDER BY source_id ASC, name ASC')
        .all() as CatalogRow[];
    return rows.map(rowToEntry);
  }

  getCatalogEntry(entryId: string): SkillCatalogEntry | null {
    const row = getRawSqlite()
      .prepare('SELECT * FROM skill_catalog_entries WHERE id = ?')
      .get(entryId) as CatalogRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async syncSource(sourceId: string): Promise<number> {
    const source = skillSourceService.getSource(sourceId);
    if (!source) throw new Error(`Skill source not found: ${sourceId}`);
    if (!source.enabled) throw new Error(`Skill source is disabled: ${sourceId}`);
    if (source.type === 'builtin' || source.type === 'local' || source.type === 'project') {
      skillSourceService.markSyncResult(sourceId, { ok: true });
      return 0;
    }

    try {
      const indexedAt = nowIso();
      let count = 0;

      if (source.type === 'git-index' && source.config.scanRoot) {
        count = await this.syncGitHubScanRoot(source, indexedAt);
      } else if (source.type === 'well-known') {
        const indexUrl = resolveIndexUrl(source);
        const index = await fetchSkillJson<WellKnownIndex>(indexUrl);
        count = this.upsertWellKnownEntries(source, index, resolveWellKnownBaseUrl(indexUrl), indexedAt);
      } else if (source.type === 'git-index') {
        const indexUrl = resolveIndexUrl(source);
        const contentBaseUrl = resolveContentBaseUrl(source, indexUrl);
        const rawIndex = await fetchSkillJson<unknown>(indexUrl);
        count = this.upsertIndexPayload(source, rawIndex, contentBaseUrl, indexedAt);
      } else {
        throw new Error(`Sync not supported for source type: ${source.type}`);
      }

      getRawSqlite().prepare('DELETE FROM skill_catalog_entries WHERE source_id = ? AND indexed_at < ?').run(sourceId, indexedAt);
      skillSourceService.markSyncResult(sourceId, { ok: true });
      return count;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skillSourceService.markSyncResult(sourceId, { ok: false, error: message });
      throw err;
    }
  }

  async syncAll(): Promise<{ synced: number; errors: Array<{ sourceId: string; message: string }> }> {
    const sources = skillSourceService.listSources().filter((source) =>
      source.enabled && (source.type === 'well-known' || source.type === 'git-index'),
    );
    let synced = 0;
    const errors: Array<{ sourceId: string; message: string }> = [];
    for (const source of sources) {
      try {
        synced += await this.syncSource(source.id);
      } catch (err) {
        errors.push({
          sourceId: source.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { synced, errors };
  }

  private upsertIndexPayload(
    source: SkillSourceRecord,
    rawIndex: unknown,
    contentBaseUrl: string,
    indexedAt: string,
  ): number {
    if (Array.isArray(rawIndex)) {
      return this.upsertEverythingSearchEntries(source, rawIndex as EverythingSearchEntry[], contentBaseUrl, indexedAt);
    }
    return this.upsertGitIndexEntries(source, rawIndex as GitIndex, contentBaseUrl, indexedAt);
  }

  private async syncGitHubScanRoot(source: SkillSourceRecord, indexedAt: string): Promise<number> {
    const repo = source.config.repo;
    if (!repo) throw new Error('git-index source requires config.repo');
    const ref = source.config.ref ?? 'main';
    const scanRoot = source.config.scanRoot ?? 'skills';
    const normalizedRepo = normalizeRepo(repo);
    const contentBase = resolveRepoContentBase(source);
    const apiBase = `https://api.github.com/repos/${normalizedRepo}/contents`;
    const listUrl = scanRoot === '.'
      ? `${apiBase}?ref=${encodeURIComponent(ref)}`
      : `${apiBase}/${scanRoot}?ref=${encodeURIComponent(ref)}`;

    const entries = await fetchSkillJson<GitHubContentEntry[]>(listUrl);
    const insert = getRawSqlite().prepare(`
      INSERT INTO skill_catalog_entries (
        id, source_id, name, description, version, remote_url, content_digest, tags_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        remote_url = excluded.remote_url,
        indexed_at = excluded.indexed_at
    `);

    let count = 0;
    for (const entry of entries) {
      if (entry.type !== 'dir') continue;
      const skillPath = `${entry.path}/SKILL.md`;
      const remoteUrl = new URL(skillPath, contentBase).toString();
      let description = entry.name;
      try {
        const raw = await fetchSkillText(remoteUrl);
        const parsed = parseSkillMarkdown(raw);
        if (typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description.trim()) {
          description = parsed.frontmatter.description.trim();
        }
      } catch {
        // Keep directory name as fallback description.
      }

      insert.run(
        `${source.id}/${entry.name}`,
        source.id,
        entry.name,
        description,
        null,
        remoteUrl,
        null,
        '[]',
        indexedAt,
      );
      count += 1;
    }
    return count;
  }

  private upsertEverythingSearchEntries(
    source: SkillSourceRecord,
    entries: EverythingSearchEntry[],
    contentBaseUrl: string,
    indexedAt: string,
  ): number {
    const insert = getRawSqlite().prepare(`
      INSERT INTO skill_catalog_entries (
        id, source_id, name, description, version, remote_url, content_digest, tags_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        remote_url = excluded.remote_url,
        tags_json = excluded.tags_json,
        indexed_at = excluded.indexed_at
    `);

    let count = 0;
    for (const item of entries) {
      if (!item.name || !item.path) continue;
      const remoteUrl = new URL(item.path, contentBaseUrl).toString();
      insert.run(
        `${source.id}/${item.name}`,
        source.id,
        item.name,
        item.description?.trim() || item.title?.trim() || item.name,
        null,
        remoteUrl,
        null,
        JSON.stringify(item.tags ?? []),
        indexedAt,
      );
      count += 1;
    }
    return count;
  }

  private upsertWellKnownEntries(
    source: SkillSourceRecord,
    index: WellKnownIndex,
    baseUrl: string,
    indexedAt: string,
  ): number {
    const insert = getRawSqlite().prepare(`
      INSERT INTO skill_catalog_entries (
        id, source_id, name, description, version, remote_url, content_digest, tags_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        version = excluded.version,
        remote_url = excluded.remote_url,
        content_digest = excluded.content_digest,
        indexed_at = excluded.indexed_at
    `);

    let count = 0;
    for (const item of index.skills ?? []) {
      if (!item.name || !item.url) continue;
      const remoteUrl = new URL(item.url, baseUrl).toString();
      insert.run(
        `${source.id}/${item.name}`,
        source.id,
        item.name,
        item.description?.trim() || item.name,
        item.version ?? null,
        remoteUrl,
        item.digest ?? null,
        '[]',
        indexedAt,
      );
      count += 1;
    }
    return count;
  }

  private upsertGitIndexEntries(
    source: SkillSourceRecord,
    index: GitIndex,
    baseUrl: string,
    indexedAt: string,
  ): number {
    const insert = getRawSqlite().prepare(`
      INSERT INTO skill_catalog_entries (
        id, source_id, name, description, version, remote_url, content_digest, tags_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        version = excluded.version,
        remote_url = excluded.remote_url,
        content_digest = excluded.content_digest,
        tags_json = excluded.tags_json,
        indexed_at = excluded.indexed_at
    `);

    let count = 0;
    for (const item of index.skills ?? []) {
      const name = item.name ?? item.id;
      if (!name || !item.url) continue;
      const remoteUrl = new URL(item.url, baseUrl).toString();
      insert.run(
        `${source.id}/${name}`,
        source.id,
        name,
        item.summary?.trim() || item.description?.trim() || name,
        item.version ?? null,
        remoteUrl,
        item.digest ?? null,
        JSON.stringify(item.tags ?? []),
        indexedAt,
      );
      count += 1;
    }
    return count;
  }
}

export const skillIndexService = new SkillIndexService();
