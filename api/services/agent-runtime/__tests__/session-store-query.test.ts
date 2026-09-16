import { beforeEach, describe, expect, it } from 'vitest';
import { getRawSqlite } from '../../../db/index.js';
import type { AgentSession } from '../contracts.js';
import { AgentNotFoundError } from '../runtime-errors.js';
import { agentRuntimeStore } from '../session-store.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

interface CapturedStatement {
  sql: string;
  args: unknown[];
}

/**
 * Wrap the raw sqlite `prepare` singleton so a single call can be inspected.
 * The compat layer defines `prepare` as configurable, so it can be swapped and
 * restored without touching production code.
 */
function captureSql<T>(run: () => T): { result: T; statements: CapturedStatement[] } {
  const db = getRawSqlite();
  const original = db.prepare.bind(db);
  const statements: CapturedStatement[] = [];
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    value: (sql: string) => {
      const statement = original(sql);
      return new Proxy(statement as object, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            statements.push({ sql, args });
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  });
  try {
    return { result: run(), statements };
  } finally {
    Object.defineProperty(db, 'prepare', { configurable: true, value: original });
  }
}

function sessionFixture(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    projectId: 'project-alpha',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'explorer',
    status: 'completed',
    title: null,
    prompt: 'fixture',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    permissionRules: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
    ...overrides,
  };
}

/** Insert a session row directly so parent/child links can be made inconsistent on purpose. */
function insertRawSession(input: {
  id: string;
  parentSessionId?: string | null;
  childSessionIdsJson?: string;
  updatedAt?: string;
  status?: AgentSession['status'];
  sessionMetadataJson?: string;
}): void {
  getRawSqlite()
    .prepare(
      `INSERT INTO agent_runtime_sessions
       (id, project_id, parent_session_id, child_session_ids_json, node_id, profile_id, status,
        title, prompt, context_snapshot_id, thinking_mode, reasoning_effort, permission_rules_json,
        created_at, updated_at, completed_at, result_summary, blocked_reason, skill_ids_json,
        mcp_server_ids_json, active_run_id, pending_resume_token, session_metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      'project-alpha',
      input.parentSessionId ?? null,
      input.childSessionIdsJson ?? '[]',
      null,
      'explorer',
      input.status ?? 'completed',
      null,
      'fixture',
      null,
      'standard',
      null,
      '[]',
      input.updatedAt ?? '2026-01-01T00:00:00.000Z',
      input.updatedAt ?? '2026-01-01T00:00:00.000Z',
      null,
      null,
      null,
      '[]',
      '[]',
      null,
      null,
      input.sessionMetadataJson ?? '{}',
    );
}

describe('listSessions SQL scoping', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('applies project/node/status filters with the previous ordering and composition', () => {
    agentRuntimeStore.createSession(sessionFixture({ id: 's1', projectId: 'p1', nodeId: 'n1', status: 'running', updatedAt: '2026-01-01T00:00:03Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 's2', projectId: 'p1', nodeId: 'n2', status: 'completed', updatedAt: '2026-01-01T00:00:02Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 's3', projectId: 'p2', nodeId: 'n1', status: 'running', updatedAt: '2026-01-01T00:00:01Z' }));

    expect(agentRuntimeStore.listSessions().map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(agentRuntimeStore.listSessions({ projectId: 'p1' }).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(agentRuntimeStore.listSessions({ nodeId: 'n1' }).map((s) => s.id)).toEqual(['s1', 's3']);
    expect(agentRuntimeStore.listSessions({ status: 'running' }).map((s) => s.id)).toEqual(['s1', 's3']);
    expect(agentRuntimeStore.listSessions({ projectId: 'p1', status: 'running' }).map((s) => s.id)).toEqual(['s1']);
    expect(agentRuntimeStore.listSessions({ projectId: 'p1', nodeId: 'n2', status: 'completed' }).map((s) => s.id)).toEqual(['s2']);
    expect(agentRuntimeStore.listSessions({ nodeId: 'n1', status: 'completed' })).toEqual([]);
  });

  it('slices to the most recently updated rows without loading the rest', () => {
    for (let i = 0; i < 60; i += 1) {
      const stamp = String(i).padStart(2, '0');
      agentRuntimeStore.createSession(
        sessionFixture({ id: `s${stamp}`, updatedAt: `2026-01-01T00:00:${stamp}.000Z` }),
      );
    }

    const defaultPage = agentRuntimeStore.listSessions({ projectId: 'project-alpha' });
    expect(defaultPage).toHaveLength(50);
    expect(defaultPage[0]?.id).toBe('s59');
    expect(defaultPage[49]?.id).toBe('s10');

    expect(agentRuntimeStore.listSessions({ projectId: 'project-alpha', limit: 3 }).map((s) => s.id)).toEqual([
      's59',
      's58',
      's57',
    ]);
    expect(agentRuntimeStore.listSessions({ projectId: 'project-alpha', limit: 0 })).toEqual([]);
    expect(agentRuntimeStore.listSessions({ projectId: 'project-alpha', limit: Number.POSITIVE_INFINITY })).toHaveLength(60);
  });

  it('keeps Array#slice semantics for negative limits', () => {
    for (let i = 1; i <= 4; i += 1) {
      agentRuntimeStore.createSession(sessionFixture({ id: `s${i}`, updatedAt: `2026-01-01T00:00:0${i}.000Z` }));
    }
    const all = agentRuntimeStore.listSessions({ limit: Number.MAX_SAFE_INTEGER });
    expect(agentRuntimeStore.listSessions({ limit: -1 }).map((s) => s.id)).toEqual(all.slice(0, -1).map((s) => s.id));
    expect(agentRuntimeStore.listSessions({ limit: -2 }).map((s) => s.id)).toEqual(all.slice(0, -2).map((s) => s.id));
  });

  it('treats empty-string filters as absent', () => {
    agentRuntimeStore.createSession(sessionFixture({ id: 's1', projectId: 'p1', nodeId: 'n1' }));
    expect(agentRuntimeStore.listSessions({ projectId: '', nodeId: '', status: '' }).map((s) => s.id)).toEqual(['s1']);
  });

  it('pushes filters and the limit into one scoped SQL statement', () => {
    agentRuntimeStore.createSession(sessionFixture({ id: 's1', projectId: 'p1', status: 'running' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 's2', projectId: 'p2', status: 'running' }));

    const { result, statements } = captureSql(() =>
      agentRuntimeStore.listSessions({ projectId: 'p1', status: 'running', limit: 5 }),
    );

    expect(result.map((s) => s.id)).toEqual(['s1']);
    const sessionQueries = statements.filter((entry) => entry.sql.includes('FROM agent_runtime_sessions'));
    expect(sessionQueries).toHaveLength(1);
    expect(sessionQueries[0]!.sql).toContain('WHERE project_id = ? AND status = ?');
    expect(sessionQueries[0]!.sql).toContain('ORDER BY updated_at DESC LIMIT ?');
    expect(sessionQueries[0]!.args).toEqual(['p1', 'running', 5]);
  });
});

describe('listSessionTree traversal', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('returns a pre-order tree and never touches unrelated sessions', () => {
    agentRuntimeStore.createSession(sessionFixture({ id: 'root', updatedAt: '2026-01-01T00:00:10Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'c1', parentSessionId: 'root', updatedAt: '2026-01-01T00:00:09Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'c2', parentSessionId: 'root', updatedAt: '2026-01-01T00:00:08Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'g1', parentSessionId: 'c1', updatedAt: '2026-01-01T00:00:07Z' }));
    // Child linked only by parent pointer (not listed in the parent's JSON array).
    insertRawSession({ id: 'pointer-child', parentSessionId: 'c2', updatedAt: '2026-01-01T00:00:06Z' });
    // Child advertised by the legacy JSON array while its own parent pointer is null.
    insertRawSession({ id: 'legacy-child', parentSessionId: null, updatedAt: '2026-01-01T00:00:05Z' });
    getRawSqlite()
      .prepare('UPDATE agent_runtime_sessions SET child_session_ids_json = ? WHERE id = ?')
      .run(JSON.stringify(['c1', 'c2', 'legacy-child']), 'root');
    // Unrelated sessions must be excluded from the walk.
    agentRuntimeStore.createSession(sessionFixture({ id: 'unrelated', updatedAt: '2026-01-01T00:00:20Z' }));
    insertRawSession({ id: 'unrelated-child', parentSessionId: 'unrelated', updatedAt: '2026-01-01T00:00:21Z' });

    expect(agentRuntimeStore.listSessionTree('root').map((s) => s.id)).toEqual([
      'root',
      'c1',
      'g1',
      'c2',
      'pointer-child',
      'legacy-child',
    ]);
  });

  it('uses a single recursive CTE instead of loading every session', () => {
    agentRuntimeStore.createSession(sessionFixture({ id: 'root' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'child', parentSessionId: 'root' }));

    const { result, statements } = captureSql(() => agentRuntimeStore.listSessionTree('root'));

    expect(result.map((s) => s.id)).toEqual(['root', 'child']);
    expect(statements).toHaveLength(1);
    const [query] = statements;
    expect(query!.sql).toContain('WITH RECURSIVE session_tree');
    expect(query!.sql).toContain('child.parent_session_id = parent.id');
    expect(query!.sql).toContain('json_each');
    // Guard against a regression to the old unbounded `SELECT * FROM agent_runtime_sessions`.
    expect(query!.sql).not.toContain('SELECT * FROM agent_runtime_sessions ORDER BY updated_at DESC');
    expect(query!.args).toEqual(['root']);
  });

  it('terminates on cycles in parent/child links', () => {
    insertRawSession({ id: 'a', parentSessionId: null, childSessionIdsJson: JSON.stringify(['b']) });
    insertRawSession({ id: 'b', parentSessionId: 'a', childSessionIdsJson: JSON.stringify(['a']) });

    expect(agentRuntimeStore.listSessionTree('a').map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('treats malformed and non-array child lists as empty', () => {
    insertRawSession({ id: 'malformed', childSessionIdsJson: 'not json' });
    insertRawSession({ id: 'object-list', childSessionIdsJson: '{}' });
    insertRawSession({ id: 'valid-child', parentSessionId: 'object-list' });

    expect(agentRuntimeStore.listSessionTree('malformed').map((s) => s.id)).toEqual(['malformed']);
    expect(agentRuntimeStore.listSessionTree('object-list').map((s) => s.id)).toEqual(['object-list', 'valid-child']);
  });

  it('throws when the root session does not exist', () => {
    expect(() => agentRuntimeStore.listSessionTree('missing-root')).toThrow(AgentNotFoundError);
  });
});

describe('listSessionsPage projected-status pagination', () => {
  beforeEach(resetAgentRuntimeFixtures);

  function seedStatuses(): void {
    // Newest first: completed, stopping(projected), blocked(unconfirmed), running, completed.
    agentRuntimeStore.createSession(sessionFixture({ id: 'c-new', status: 'completed', updatedAt: '2026-01-01T00:00:05Z' }));
    agentRuntimeStore.createSession(sessionFixture({
      id: 'stopping', status: 'running', updatedAt: '2026-01-01T00:00:04Z',
      sessionMetadata: { runtimeControl: { state: 'stopping' } },
    }));
    agentRuntimeStore.createSession(sessionFixture({
      id: 'unconfirmed', status: 'running', updatedAt: '2026-01-01T00:00:03Z',
      sessionMetadata: { runtimeControl: { state: 'unconfirmed' } },
    }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'running', status: 'running', updatedAt: '2026-01-01T00:00:02Z' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'c-old', status: 'completed', updatedAt: '2026-01-01T00:00:01Z' }));
  }

  it('reports exact totalCount and countByStatus over the projected status', () => {
    seedStatuses();
    const page = agentRuntimeStore.listSessionsPage({}, { limit: 2, offset: 0 });

    expect(page.totalCount).toBe(5);
    expect(page.countByStatus).toEqual({ completed: 2, stopping: 1, blocked: 1, running: 1 });
    // Items remain unprojected rows; the caller applies projectSessionState.
    expect(page.items.map((s) => s.id)).toEqual(['c-new', 'stopping']);
    expect(page.items[1]!.status).toBe('running');
  });

  it('filters by projected status, matching the stopping/unconfirmed rewrite', () => {
    seedStatuses();

    expect(agentRuntimeStore.listSessionsPage({ status: 'stopping' }, { limit: 50, offset: 0 })).toMatchObject({
      totalCount: 1,
      countByStatus: { stopping: 1 },
    });
    expect(agentRuntimeStore.listSessionsPage({ status: 'stopping' }, { limit: 50, offset: 0 }).items.map((s) => s.id)).toEqual(['stopping']);
    expect(agentRuntimeStore.listSessionsPage({ status: 'blocked' }, { limit: 50, offset: 0 }).items.map((s) => s.id)).toEqual(['unconfirmed']);
    // The persisted `running` status must not leak the two rewritten rows.
    expect(agentRuntimeStore.listSessionsPage({ status: 'running' }, { limit: 50, offset: 0 }).items.map((s) => s.id)).toEqual(['running']);
    expect(agentRuntimeStore.listSessionsPage({ status: 'completed' }, { limit: 50, offset: 0 }).items.map((s) => s.id)).toEqual(['c-new', 'c-old']);
  });

  it('pages with the updated_at DESC order and clamps a non-positive window', () => {
    seedStatuses();
    expect(agentRuntimeStore.listSessionsPage({}, { limit: 2, offset: 2 }).items.map((s) => s.id)).toEqual(['unconfirmed', 'running']);
    expect(agentRuntimeStore.listSessionsPage({}, { limit: 2, offset: 4 }).items.map((s) => s.id)).toEqual(['c-old']);
    expect(agentRuntimeStore.listSessionsPage({}, { limit: 2, offset: 99 }).items).toEqual([]);
    // SQLite treats LIMIT -1 as unbounded; the guard must keep it empty.
    expect(agentRuntimeStore.listSessionsPage({}, { limit: -1, offset: 0 }).items).toEqual([]);
    expect(agentRuntimeStore.listSessionsPage({}, { limit: 0, offset: 0 }).items).toEqual([]);
  });

  it('falls back to the persisted status when session_metadata_json is malformed', () => {
    insertRawSession({ id: 'bad-meta', status: 'running', sessionMetadataJson: 'not json', updatedAt: '2026-01-01T00:00:01Z' });
    insertRawSession({ id: 'null-safe', status: 'completed', sessionMetadataJson: null as unknown as string, updatedAt: '2026-01-01T00:00:02Z' });

    const page = agentRuntimeStore.listSessionsPage({}, { limit: 50, offset: 0 });
    expect(page.countByStatus).toEqual({ running: 1, completed: 1 });
    expect(page.totalCount).toBe(2);
  });

  it('resolves status filtering and paging without materializing every session', () => {
    seedStatuses();
    const { result, statements } = captureSql(() =>
      agentRuntimeStore.listSessionsPage({ projectId: 'project-alpha', status: 'running' }, { limit: 1, offset: 0 }),
    );

    expect(result.items.map((s) => s.id)).toEqual(['running']);
    const sessionQueries = statements.filter((entry) => entry.sql.includes('FROM agent_runtime_sessions'));
    expect(sessionQueries).toHaveLength(2);
    const [countQuery, pageQuery] = sessionQueries;
    expect(countQuery!.sql).toContain('GROUP BY projected_status');
    expect(countQuery!.sql).toContain('WHERE projected_status = ?');
    expect(countQuery!.args).toEqual(['project-alpha', 'running']);
    // The page query is bounded by LIMIT/OFFSET and never enumerates the tail.
    expect(pageQuery!.sql).toContain('WHERE projected_status = ?');
    expect(pageQuery!.sql).toContain('ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    expect(pageQuery!.args).toEqual(['project-alpha', 'running', 1, 0]);
  });
});

describe('getSessionStats active sub-agent counting', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('counts running children with one status lookup and ignores missing ids', () => {
    const parent = agentRuntimeStore.createSession(sessionFixture({ id: 'parent', status: 'running' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'run-child', parentSessionId: parent.id, status: 'running' }));
    agentRuntimeStore.createSession(sessionFixture({ id: 'done-child', parentSessionId: parent.id, status: 'completed' }));
    // Duplicate entries count once per entry, matching the previous per-id loop.
    agentRuntimeStore.updateSession(parent.id, {
      childSessionIds: ['run-child', 'run-child', 'done-child', 'deleted-child'],
    });

    const { result, statements } = captureSql(() => agentRuntimeStore.getSessionStats(parent.id));

    expect(result.activeSubAgentCount).toBe(2);
    const statusQueries = statements.filter((entry) => entry.sql.includes("status = 'running' AND id IN"));
    expect(statusQueries).toHaveLength(1);
    expect(statusQueries[0]!.args).toEqual(['run-child', 'done-child', 'deleted-child']);
  });
});
