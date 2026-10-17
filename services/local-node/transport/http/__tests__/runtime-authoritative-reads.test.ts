import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
import { RuntimeSidecarError } from '../../../modules/agent-runtime/sidecar/sidecar-client.js';
import * as database from '../../../infrastructure/database/index.js';
import type { AgentSession, ToolCallRecord } from '../../../modules/agent-runtime/contracts.js';
import { invalidateSessionEnvironment } from '../../../modules/agent-runtime/session-environment.js';

let workspace: string;
const id = 'rust-only-session';
let session: AgentSession;
let call: ToolCallRecord;
let sessionSqlAttempts: string[];
function assertNoSessionSql() { expect(sessionSqlAttempts).toEqual([]); }
beforeEach(() => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'synax-rust-reads-')));
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  writeFileSync(path.join(workspace, 'result.txt'), 'rust history\n');
  session = {
    id, projectId: 'rust-project', parentSessionId: null, childSessionIds: [], profileId: 'explorer', status: 'completed',
    title: 'Rust session', prompt: 'Inspect files', sessionMetadata: { backend: { workDir: workspace } },
    nodeId: null, contextSnapshotId: null, thinkingMode: 'standard', permissionRules: [],
    createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', completedAt: null,
    resultSummary: null, blockedReason: null, skillIds: [], mcpServerIds: [], activeRunId: null, pendingResumeToken: null,
  };
  call = { id: 'read-1', sessionId: id, toolId: 'file.read', status: 'completed', category: 'read', mutability: 'read',
    inputRef: { path: 'result.txt' }, outputRef: 'rust history', startedAt: '2026-10-17T00:00:00Z',
  } as ToolCallRecord;
  vi.spyOn(runtimeFacade, 'uiSnapshotAuthoritative').mockImplementation(async () => ({ session, run: null, cursor: 10, liveChunks: [], completedStepIds: [] }));
  vi.spyOn(runtimeFacade, 'listSessionProjection').mockResolvedValue([session]);
  vi.spyOn(runtimeFacade, 'listHistoryObjects').mockResolvedValue([call]);
  vi.spyOn(runtimeFacade, 'listMessageHistory').mockResolvedValue([]);
  vi.spyOn(runtimeFacade, 'listBoundAssets').mockResolvedValue([]);
  invalidateSessionEnvironment(id);
  sessionSqlAttempts = [];
  const db = database.getRawSqlite();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    // Git subprocess bookkeeping still uses agent_runtime_processes. This gate
    // covers session/history/asset read models, not the unfinished process cutover.
    if (/\b(?:agent_runtime_(?!processes\b)\w+|conversation_\w+)\b/i.test(sql)) {
      sessionSqlAttempts.push(sql);
      throw new Error('authoritative HTTP must not read session/history SQLite');
    }
    return prepare(sql);
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  invalidateSessionEnvironment(id);
  rmSync(workspace, { recursive: true, force: true });
});

it('reads environment, recorded input and invocation usage with no session/history SQLite mirror', async () => {
  const environment = await agentRuntimeRoutes.request(`/sessions/${id}/environment`);
  expect(environment.status, await environment.clone().text()).toBe(200);
  expect(await environment.json()).toMatchObject({ sessionId: id, workspacePath: workspace,
    inputSources: [expect.objectContaining({ path: 'result.txt', toolCallId: 'read-1' })] });
  const input = await agentRuntimeRoutes.request(`/sessions/${id}/environment/input-source/read-1`);
  expect(input.status).toBe(200);
  expect(await input.json()).toEqual({ content: 'rust history', truncated: false });
  const usage = await agentRuntimeRoutes.request(`/sessions/${id}/invocation-usage`);
  expect(usage.status).toBe(200);
  expect(await usage.json()).toMatchObject({ totalCalls: 1, items: [{ id: 'file.read', callCount: 1 }] });
  assertNoSessionSql();
});

it.each(['archivedAt', 'deletedAt'])('uses the Rust %s tombstone to reject reads', async (field) => {
  session.sessionMetadata = { ...session.sessionMetadata, [field]: '2026-10-17T00:00:00Z' };
  const response = await agentRuntimeRoutes.request(`/sessions/${id}/invocation-usage`);
  expect(response.status).toBe(404);
  expect(runtimeFacade.listHistoryObjects).not.toHaveBeenCalled();
  assertNoSessionSql();
});

it('returns a missing session for absent Rust projection, without recreating it from SQL', async () => {
  vi.mocked(runtimeFacade.uiSnapshotAuthoritative).mockRejectedValue(new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MISSING', message: 'missing' }));
  const seed = vi.spyOn(runtimeFacade, 'ensureUiProjection');
  const response = await agentRuntimeRoutes.request(`/sessions/${id}/invocation-usage`);
  expect(response.status).toBe(404);
  expect(seed).not.toHaveBeenCalled();
  assertNoSessionSql();
});

it('propagates Rust unavailability rather than answering from a stale SQL mirror', async () => {
  vi.mocked(runtimeFacade.uiSnapshotAuthoritative).mockRejectedValue(new RuntimeSidecarError({ type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'unavailable' }));
  const response = await agentRuntimeRoutes.request(`/sessions/${id}/invocation-usage`);
  expect(response.status).toBe(503);
  assertNoSessionSql();
});
