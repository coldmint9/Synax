import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitMrService } from '../../git-mr/service.js';
import { GitMrStore } from '../../git-mr/store.js';
import { ConversationGitService } from './service.js';
import type { ConversationGitCreate, ConversationGitSnapshot, ConversationGitActionName } from './contracts.js';
import type { AgentRuntimeMessage } from '../contracts.js';
import type { ProjectWorkspaceRoot } from '../../project-workspace.js';

let directory: string;
let repo: string;
let store: GitMrStore;
let gitMr: GitMrService;
let service: ConversationGitService;
let roots: ProjectWorkspaceRoot[];
let projectId: string;
let messages: Map<string, AgentRuntimeMessage>;
let appendMessage: ReturnType<typeof vi.fn<(message: AgentRuntimeMessage) => AgentRuntimeMessage>>;
let flushSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
let emitMessages: ReturnType<typeof vi.fn<(sessionId: string, messages: AgentRuntimeMessage[]) => void>>;
let requestSequence = 0;
const request = () => `request-${++requestSequence}`;
const git = (...args: string[]) => execFileSync('git', args, {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
function commit(name: string, text: string) {
  fs.writeFileSync(path.join(repo, name), text);
  git('add', '--', name); git('commit', '-m', name);
}
function source(name: string, file: string, content: string) {
  git('checkout', '-b', name, 'main'); commit(file, content); git('checkout', 'main');
}
function runtime() {
  return {
    getSession: (id: string) => ({ id, projectId }),
    appendMessage,
    flushSession,
  };
}
function instance() {
  return new ConversationGitService({ gitMr, store, runtimeStore: runtime(), resolveRoots: () => roots, emitMessages });
}
function create(overrides: Partial<ConversationGitCreate> = {}, context = {}) {
  return service.create('session', { requestId: request(), rootId: 'root', title: '会话内合并', target: 'integration',
    sources: ['feature/a'], strategy: 'merge_commit', ...overrides }, context);
}
function act(snapshot: ConversationGitSnapshot, action: ConversationGitActionName, requestId = request()) {
  return service.action('session', snapshot.task.id, { action, requestId,
    expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version });
}
const get = (snapshot: ConversationGitSnapshot) => service.get('session', snapshot.task.id);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-conversation-git-'));
  repo = path.join(directory, 'repo'); fs.mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Conversation test'); git('config', 'user.email', 'conversation@example.test');
  commit('app.ts', 'export const value = 1;\n');
  git('branch', 'integration'); source('feature/a', 'a.ts', 'export const a = 1;\n');
  roots = [{ id: 'root', name: 'Repo', path: repo, role: 'primary', status: 'available' }];
  projectId = 'project';
  store = new GitMrStore(path.join(directory, 'state'));
  gitMr = new GitMrService(store);
  messages = new Map();
  appendMessage = vi.fn((message: AgentRuntimeMessage) => { messages.set(message.id, structuredClone(message)); return message; });
  flushSession = vi.fn(async () => undefined);
  emitMessages = vi.fn();
  service = instance();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('conversation merge service with real isolated Git operations', { timeout: 60_000 }, () => {
  it('creates only a draft and persists one stable anchor without GET side effects', async () => {
    const snapshot = await create({ autoFinalize: true } as unknown as Partial<ConversationGitCreate>, { runId: 'run', stepId: 'step', toolCallId: 'call' });
    expect(snapshot.mr.status).toBe('draft');
    expect(snapshot.mr.autoFinalize).toBe(false);
    expect(snapshot.mr.worktree).toBeUndefined();
    expect(snapshot.reference.objectId).toBe(snapshot.task.id);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({ id: snapshot.task.messageId, runId: null, stepId: null,
      metadata: { source: 'git_merge_task', originRunId: 'run', originStepId: 'step', originToolCallId: 'call' } });
    expect(snapshot.messages[0].content).toContain(snapshot.task.id);
    expect(flushSession).toHaveBeenCalledTimes(1);
    expect(emitMessages).toHaveBeenCalledWith('session', snapshot.messages);
    const writes = appendMessage.mock.calls.length;
    await get(snapshot); await get(snapshot); await service.list('session');
    expect(appendMessage).toHaveBeenCalledTimes(writes);
    expect(snapshot.commits.length).toBeGreaterThan(0);
    for (const item of snapshot.commits) {
      expect(git('show', '-s', '--format=%s', item.oid)).toBe(item.subject);
      expect(git('show', '-s', '--format=%P', item.oid).split(' ').filter(Boolean)).toEqual(item.parents);
    }
    const reloaded = instance();
    expect((await reloaded.get('session', snapshot.task.id)).messages).toEqual(snapshot.messages);
  });

  it('rejects session, project and changed-root mismatches and ambiguous roots', async () => {
    const snapshot = await create();
    await expect(service.get('other-session', snapshot.task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    projectId = 'another-project';
    await expect(get(snapshot)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    projectId = 'project';
    roots.push({ id: 'reference', name: 'Reference', path: repo, role: 'reference', status: 'available' });
    await expect(create({ rootId: undefined })).rejects.toMatchObject({ code: 'ROOT_REQUIRED' });
    await expect(create({ rootId: 'unknown' })).rejects.toMatchObject({ code: 'ROOT_UNAVAILABLE' });
    roots[0] = { ...roots[0], path: directory };
    await expect(get(snapshot)).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_CHANGED' });
  });

  it('persists create/action idempotency and rejects changed arguments without executing twice', async () => {
    const requestId = request();
    const first = await create({ requestId });
    const again = await create({ requestId });
    expect(again.task.id).toBe(first.task.id);
    expect(await store.list('requests', 'project')).toHaveLength(1);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    await expect(create({ requestId, title: 'Different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const actionId = request();
    const input = { action: 'prepare' as const, requestId: actionId, expectedTaskRevision: first.task.revision, expectedVersion: first.mr.version };
    const prepared = await service.action('session', first.task.id, input);
    const repeated = await instance().action('session', first.task.id, input);
    expect(repeated.mr.version).toBe(prepared.mr.version);
    expect(repeated.task.revision).toBe(prepared.task.revision);
    expect(repeated.messages).toHaveLength(2);
    expect(emitMessages.mock.calls.at(-1)![1]).toHaveLength(2);
    expect(repeated.messages[1]).toMatchObject({ runId: null, stepId: null, metadata: { source: 'git_merge_receipt' } });
    await expect(service.action('session', first.task.id, { ...input, action: 'finalize' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(act(first, 'prepare')).rejects.toMatchObject({ code: 'STALE_TASK_REVISION' });
  });

  it('coalesces concurrent repeated actions and keeps polling available', async () => {
    const snapshot = await create();
    const input = { action: 'prepare' as const, requestId: request(), expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version };
    const [one, two] = await Promise.all([
      service.action('session', snapshot.task.id, input),
      service.action('session', snapshot.task.id, input),
    ]);
    expect(one.mr.id).toBe(two.mr.id);
    expect(one.mr.version).toBe(two.mr.version);
    expect(one.messages).toHaveLength(2);
  });

  it('recovers failed message delivery on an idempotent retry without recreating or preparing again', async () => {
    const requestId = request();
    flushSession.mockRejectedValueOnce(new Error('runtime storage temporarily unavailable'));
    await expect(create({ requestId })).rejects.toThrow('temporarily unavailable');
    const snapshot = await create({ requestId });
    expect(await store.list('requests', 'project')).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(1);
    const actionInput = { action: 'prepare' as const, requestId: request(),
      expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version };
    flushSession.mockRejectedValueOnce(new Error('runtime storage temporarily unavailable'));
    await expect(service.action('session', snapshot.task.id, actionInput)).rejects.toThrow('temporarily unavailable');
    const beforeRetry = await get(snapshot);
    const writesBeforeGet = appendMessage.mock.calls.length;
    await get(snapshot);
    expect(appendMessage).toHaveBeenCalledTimes(writesBeforeGet);
    const recovered = await instance().action('session', snapshot.task.id, actionInput);
    expect(recovered.mr.version).toBe(beforeRetry.mr.version);
    expect(recovered.task.revision).toBe(beforeRetry.task.revision);
    expect(recovered.messages).toHaveLength(2);
    expect(messages.size).toBe(2);
  });

  it.each(['outcome journal', 'task receipt', 'runtime flush'] as const)(
    'does not publish again when finalize succeeds but %s fails', async fault => {
      let snapshot = await create(); snapshot = await act(snapshot, 'prepare');
      const input = { action: 'finalize' as const, requestId: request(),
        expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version };
      const finalize = vi.spyOn(gitMr, 'finalize');
      const originalWrite = store.write.bind(store);
      let injected = false;
      const write = vi.spyOn(store, 'write').mockImplementation(async (kind, item) => {
        const record = item as { operation?: string; outcome?: unknown; messages?: AgentRuntimeMessage[] };
        const target = fault === 'outcome journal'
          ? kind === 'conversation-requests' && record.operation === 'finalize' && Boolean(record.outcome)
          : fault === 'task receipt' && kind === 'conversation-tasks' && record.messages?.some(message => message.metadata.operation === 'finalize');
        if (!injected && target) { injected = true; throw new Error(`fault: ${fault}`); }
        return originalWrite(kind, item);
      });
      if (fault === 'runtime flush') flushSession.mockRejectedValueOnce(new Error(`fault: ${fault}`));
      await expect(service.action('session', snapshot.task.id, input)).rejects.toThrow(`fault: ${fault}`);
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(git('rev-parse', 'integration')).toBe(snapshot.mr.candidateOid);
      write.mockRestore();
      const recovered = await instance().action('session', snapshot.task.id, input);
      expect(recovered.mr.status).toBe('merged');
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(recovered.messages.filter(message => message.metadata.operation === 'finalize')).toHaveLength(1);
      expect(recovered.task.revision).toBe(snapshot.task.revision + 1);
      finalize.mockRestore();
    },
  );

  it('bounds polling receipts and suggestions while preserving complete durable history', async () => {
    source('feature/b', 'a.ts', 'export const a = 2;\n');
    let snapshot = await create({ sources: ['feature/a', 'feature/b'] });
    snapshot = await act(snapshot, 'prepare');
    const task = await store.read<ConversationGitSnapshot['task'] & { messages: AgentRuntimeMessage[] }>('conversation-tasks', snapshot.task.id);
    const receipts = Array.from({ length: 30 }, (_, index): AgentRuntimeMessage => ({
      id: `historic-${index}`, sessionId: 'session', runId: null, stepId: null, role: 'assistant',
      content: `历史回执 ${index}`, metadata: { source: 'git_merge_receipt' }, createdAt: new Date(index * 1000).toISOString(),
    }));
    task.messages.push(...receipts);
    await store.write('conversation-tasks', task);
    for (const receipt of receipts) appendMessage(receipt);
    const file = await service.file('session', snapshot.task.id, snapshot.files.find(file => file.conflicted)!.id);
    await service.propose('session', snapshot.task.id, { fileId: file.id, revision: file.revision, content: 'old proposal', rationale: 'old' });
    await new Promise(resolve => setTimeout(resolve, 2));
    const latest = await service.propose('session', snapshot.task.id, { fileId: file.id, revision: file.revision, content: 'latest proposal', rationale: 'latest' });
    const writes = appendMessage.mock.calls.length;
    snapshot = await get(snapshot);
    expect(snapshot.messages).toHaveLength(17);
    expect(snapshot.messages[0].id).toBe(snapshot.task.messageId);
    expect(snapshot.messages.at(-1)?.id).toBe('historic-29');
    expect(snapshot.messages[1].id).toBe('historic-14');
    expect(snapshot.proposals).toEqual([expect.objectContaining({ id: latest.id, content: latest.content })]);
    expect(await gitMr.proposals('project', snapshot.mr.id)).toHaveLength(2);
    expect((await store.read<typeof task>('conversation-tasks', snapshot.task.id)).messages).toHaveLength(32);
    expect(messages.has('historic-0')).toBe(true);
    expect(appendMessage).toHaveBeenCalledTimes(writes);
  });

  it('skips configured verification only on explicit finalize and records the bypass without fake passes', async () => {
    let snapshot = await create({ checks: [{ id: 'failing', executable: process.execPath, args: ['-e', 'process.exit(1)'], timeoutMs: 5000 }] });
    snapshot = await act(snapshot, 'prepare');
    await expect(act(snapshot, 'finalize')).rejects.toMatchObject({ code: 'CHECKS_REQUIRED' });
    snapshot = await get(snapshot);
    snapshot = await service.action('session', snapshot.task.id, { action: 'finalize', skipChecks: true, requestId: request(), expectedVersion: snapshot.mr.version, expectedTaskRevision: snapshot.task.revision });
    expect(snapshot.mr.status).toBe('merged');
    expect(snapshot.mr.checkResults).toEqual([]);
    expect(snapshot.mr.skippedChecks?.tree).toBe(snapshot.mr.candidateTree);
    expect(snapshot.messages.at(-1)?.content).toContain('跳过验证');
    expect(git('rev-parse', 'integration')).toBe(snapshot.mr.candidateOid);
  });

  it('resolves real conflicts, applies suggestions only on accept, checks and finalizes once', async () => {
    source('feature/b', 'a.ts', 'export const a = 2;\n');
    const before = git('rev-parse', 'integration');
    let snapshot = await create({ sources: ['feature/a', 'feature/b'], checks: [{ id: 'syntax', executable: process.execPath,
      args: ['-e', "const s=require('fs').readFileSync('a.ts','utf8');process.exit(s.includes('a = 3')?0:1)"], timeoutMs: 5000 }] });
    snapshot = await act(snapshot, 'prepare');
    expect(snapshot.mr.status).toBe('conflicted');
    const summary = snapshot.files.find(file => file.conflicted)!;
    const original = await service.file('session', snapshot.task.id, summary.id);
    await expect(service.saveFile('session', snapshot.task.id, original.id, {
      requestId: request(), expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version + 1,
      expectedRevision: original.revision, content: 'invalid version', resolve: false,
    })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(service.saveFile('session', snapshot.task.id, original.id, {
      requestId: request(), expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version,
      expectedRevision: 'old-file-revision', content: 'invalid revision', resolve: false,
    })).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    expect((await service.file('session', snapshot.task.id, original.id)).result).toBe(original.result);
    const proposal = await service.propose('session', snapshot.task.id, { fileId: original.id, revision: original.revision,
      content: 'export const a = 3;\n', rationale: 'Combine both changes' });
    expect((await service.file('session', snapshot.task.id, original.id)).result).toBe(original.result);
    snapshot = await service.applyProposal('session', snapshot.task.id, { proposalId: proposal.id, requestId: request(),
      expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version });
    const draft = await service.file('session', snapshot.task.id, original.id);
    expect(draft.result).toBe(proposal.content);
    expect(draft.conflicted).toBe(true);
    const save = { requestId: request(), expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version,
      expectedRevision: draft.revision, content: draft.result, resolve: true };
    snapshot = await service.saveFile('session', snapshot.task.id, original.id, save);
    const repeated = await instance().saveFile('session', snapshot.task.id, original.id, save);
    expect(repeated.task.revision).toBe(snapshot.task.revision);
    snapshot = await act(snapshot, 'continue');
    expect(snapshot.mr.status).toBe('ready');
    expect(git('rev-parse', 'integration')).toBe(before);
    await expect(act(snapshot, 'finalize')).rejects.toMatchObject({ code: 'CHECKS_REQUIRED' });
    snapshot = await get(snapshot);
    snapshot = await act(snapshot, 'checks');
    expect(snapshot.mr.checkResults[0].status).toBe('passed');
    const finalInput = { action: 'finalize' as const, requestId: request(), expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version };
    snapshot = await service.action('session', snapshot.task.id, finalInput);
    expect(snapshot.mr.status).toBe('merged');
    expect(git('rev-parse', 'integration')).toBe(snapshot.mr.candidateOid);
    expect(git('show', 'integration:a.ts')).toBe('export const a = 3;');
    expect((await service.action('session', snapshot.task.id, finalInput)).mr.version).toBe(snapshot.mr.version);
    expect(new Set(snapshot.messages.map(message => message.id)).size).toBe(snapshot.messages.length);
    expect(snapshot.messages[0].id).toBe(snapshot.task.messageId);
    expect(snapshot.commits.find(commit => commit.oid === snapshot.mr.candidateOid)?.refs).toContain('integration');
    expect(emitMessages.mock.calls.every(([, items]) => items.length <= 2)).toBe(true);
  });

  it('detects target movement and replans a new draft in the same task, retaining old MR and anchor', async () => {
    let snapshot = await create(); snapshot = await act(snapshot, 'prepare');
    const old = snapshot.mr.id, anchor = snapshot.task.messageId;
    git('checkout', 'integration'); commit('new.ts', 'new target\n'); git('checkout', 'main');
    expect((await get(snapshot)).stale).toBe(true);
    await expect(act(snapshot, 'finalize')).rejects.toMatchObject({ code: 'STALE_PLAN' });
    snapshot = await act(snapshot, 'replan');
    expect(snapshot.task.previousMrIds).toEqual([old]);
    expect(snapshot.task.messageId).toBe(anchor);
    expect(snapshot.mr.id).not.toBe(old);
    expect(snapshot.mr.status).toBe('draft');
    expect(snapshot.mr.targetOid).toBe(git('rev-parse', 'integration'));
    expect(snapshot.stale).toBe(false);
    expect((await gitMr.get('project', old)).worktree).toBeTruthy();
    expect(snapshot.messages.filter(message => message.metadata.source === 'git_merge_task')).toHaveLength(1);
  });

  it('cancels a running verification without waiting on an outer operation lock', async () => {
    let snapshot = await create({ checks: [{ id: 'slow', executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 60000)'], timeoutMs: 65_000 }] });
    snapshot = await act(snapshot, 'prepare');
    const running = act(snapshot, 'checks').then(value => ({ value }), error => ({ error }));
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await get(snapshot);
      if (snapshot.mr.status === 'checking') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(snapshot.mr.status).toBe('checking');
    const started = Date.now();
    await act(snapshot, 'cancel');
    const settled = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect('error' in settled).toBe(true);
    snapshot = await get(snapshot);
    snapshot = await act(snapshot, 'cancel');
    expect(snapshot.mr.status).toBe('cancelled');
    expect(fs.existsSync(snapshot.mr.worktree!)).toBe(true);
    expect(git('rev-parse', 'integration')).toBe(snapshot.mr.targetOid);
  });
});
