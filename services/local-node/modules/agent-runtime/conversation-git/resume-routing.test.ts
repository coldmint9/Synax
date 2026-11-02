import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitMrService } from '../../git-mr/service.js';
import { GitMrStore } from '../../git-mr/store.js';
import { ConversationGitService } from './service.js';
import type { ConversationGitSnapshot } from './contracts.js';
import type { AgentRuntimeMessage } from '../contracts.js';
import type { ProjectWorkspaceRoot } from '../../project-workspace.js';

const mocks = vi.hoisted(() => ({ resume: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock('./worker.js', () => ({
  resumeConversationMergeWorker: mocks.resume,
  startConversationMergeWorker: mocks.start,
  cancelConversationMergeWorker: mocks.cancel,
  pauseConversationMergeWorker: vi.fn(),
  waitForConversationMergeWorker: vi.fn(),
}));

let directory: string;
let repo: string;
let store: GitMrStore;
let gitMr: GitMrService;
let service: ConversationGitService;
let roots: ProjectWorkspaceRoot[];
let requestSequence = 0;

const git = (...args: string[]) => execFileSync('git', args, {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
function commit(name: string, text: string) {
  fs.writeFileSync(path.join(repo, name), text);
  git('add', '--', name); git('commit', '-m', name);
}
function runtime() {
  return {
    getSession: (id: string) => ({ id, projectId: 'project' }),
    appendMessage: vi.fn((message: AgentRuntimeMessage) => message),
    flushSession: vi.fn(async () => undefined),
  };
}
function instance() {
  return new ConversationGitService({ gitMr, store, runtimeStore: runtime(), resolveRoots: () => roots, emitMessages: vi.fn(), emitState: vi.fn() });
}
function draft(): Promise<ConversationGitSnapshot> {
  return service.create('session', {
    requestId: `create-${++requestSequence}`, rootId: 'root', title: '会话内合并',
    target: 'integration', sources: ['feature/a'], strategy: 'merge_commit',
  }, {});
}

beforeEach(() => {
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-conversation-routing-'));
  repo = path.join(directory, 'repo'); fs.mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Routing test'); git('config', 'user.email', 'routing@example.test');
  commit('app.ts', 'export const value = 1;\n');
  git('branch', 'integration');
  git('checkout', '-b', 'feature/a', 'main'); commit('a.ts', 'export const a = 1;\n'); git('checkout', 'main');
  roots = [{ id: 'root', name: 'Repo', path: repo, role: 'primary', status: 'available' }];
  store = new GitMrStore(path.join(directory, 'state'));
  gitMr = new GitMrService(store);
  service = instance();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

/** An unstarted draft has no execution record: continuing it must launch the worker. */
it('routes resume of an unstarted draft to the merge worker', async () => {
  const snapshot = await draft();
  expect(snapshot.mr.status).toBe('draft');
  expect(snapshot.execution).toBeUndefined();
  const mrResume = vi.spyOn(gitMr, 'resume');
  mocks.resume.mockResolvedValue(snapshot);
  await service.action('session', snapshot.task.id, {
    action: 'resume', requestId: 'resume-draft',
    expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version,
  });
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith('session', snapshot.task.id);
  expect(mrResume).not.toHaveBeenCalled();
  expect((await service.get('session', snapshot.task.id)).mr.status).toBe('draft');
});

/** Starting a draft belongs to the worker's prepare step; MR recovery must not reject it. */
it('reconciles a draft instead of reporting that no recovery is needed', async () => {
  const snapshot = await draft();
  const resumed = await gitMr.resume('project', snapshot.mr.id, snapshot.mr.version);
  expect(resumed.status).toBe('draft');
  expect(resumed.error).toBeUndefined();
  expect(resumed.events.at(-1)?.message).toContain('has not started');
});

/** Recovery of a started merge still refuses states it cannot restore. */
it('still rejects a merge that is already prepared', async () => {
  const snapshot = await draft();
  await gitMr.prepare('project', snapshot.mr.id, snapshot.mr.version);
  const prepared = await gitMr.get('project', snapshot.mr.id);
  await expect(gitMr.resume('project', prepared.id, prepared.version)).rejects.toMatchObject({ code: 'INVALID_STATE' });
});

/** Reconciling a draft must also clear the misleading error a card may still show. */
it('clears a previous error once the draft is reconciled', async () => {
  const snapshot = await draft();
  const record = await store.get('project', snapshot.mr.id);
  record.error = 'This MR does not need recovery.';
  const saved = await store.save(record);
  expect(saved.error).toBe('This MR does not need recovery.');
  const resumed = await gitMr.resume('project', saved.id, saved.version);
  expect(resumed.status).toBe('draft');
  expect(resumed.error).toBeUndefined();
});
