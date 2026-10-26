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


function stable(value: any): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',') + '}';
}
async function interruptedRequest(snapshot: ConversationGitSnapshot, operation: 'pause' | 'resume') {
  const { createHash } = await import('node:crypto');
  const input = { action: operation, requestId: `crashed-${operation}`, expectedTaskRevision: snapshot.task.revision, expectedVersion: snapshot.mr.version };
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const id = digest(`session\0${input.requestId}`);
  await store.write('conversation-requests', { id, sessionId:'session', projectId, objectId:snapshot.task.id, operation,
    argsHash:digest(stable({objectId:snapshot.task.id,operation,args:input})), status:'pending', pid:process.pid, createdAt:new Date().toISOString() });
  const stored = await store.read<any>('conversation-tasks', snapshot.task.id);
  stored.activeRequest = id;
  await store.write('conversation-tasks', stored);
  return { id, input };
}

describe('merge command recovery after a host interruption', { timeout: 60_000 }, () => {
  it('re-enters a stopped generation once and fences concurrent stops or repeated admissions', async () => {
    const snapshot = await create();
    const stopped = await service.setWorkerExecution('session', snapshot.task.id, { status: 'waiting_user', epoch: 1, phase: 'resolving' });
    const fence = { epoch: stopped.epoch, revision: stopped.revision };
    const running = await service.setWorkerExecution('session', snapshot.task.id, { status: 'running', epoch: 2 }, fence);
    expect(running).toMatchObject({ status: 'running', epoch: 2 });
    await expect(service.setWorkerExecution('session', snapshot.task.id, { status: 'running', epoch: 2 }, fence)).rejects.toMatchObject({ code: 'WORKER_FENCED' });
    const paused = await service.setWorkerExecution('session', snapshot.task.id, { status: 'paused', stopRequested: 'pause' });
    await service.setWorkerExecution('session', snapshot.task.id, { status: 'cancelling', stopRequested: 'cancel' });
    await expect(service.setWorkerExecution('session', snapshot.task.id, { status: 'running', epoch: 3 }, { epoch: paused.epoch, revision: paused.revision })).rejects.toMatchObject({ code: 'WORKER_FENCED' });
    expect((await service.workerSnapshot('session', snapshot.task.id)).execution).toMatchObject({ status: 'cancelling', stopRequested: 'cancel' });
  });
  it('repairs a pending resume with no outcome using durable task state even if its old PID is alive', async () => {
    const snapshot = await create();
    await service.setWorkerExecution('session',snapshot.task.id,{ status:'running',epoch:2,joinMode:'async',phase:'resolving' });
    const current = await service.workerSnapshot('session',snapshot.task.id);
    const {id,input} = await interruptedRequest(current,'resume');
    const restarted = instance();
    const [first,second] = await Promise.all([restarted.get('session',snapshot.task.id),restarted.get('session',snapshot.task.id)]);
    expect(first.execution?.status).toBe('recovery_required');
    expect(second.execution?.revision).toBe(first.execution?.revision);
    const receipt = await store.read<any>('conversation-requests',id);
    expect(receipt).toMatchObject({ status:'failed',error:{code:'OPERATION_INTERRUPTED'},messagesDelivered:true });
    expect((await store.read<any>('conversation-tasks',snapshot.task.id)).activeRequest).toBeUndefined();
    await expect(restarted.action('session',snapshot.task.id,input)).rejects.toMatchObject({code:'OPERATION_INTERRUPTED'});
  });

  it('repairs a pause receipt after durable paused state without replaying the stop', async () => {
    const snapshot = await create();
    await service.setWorkerExecution('session',snapshot.task.id,{ status:'paused',epoch:1,joinMode:'blocking',phase:'resolving' });
    const current = await service.workerSnapshot('session',snapshot.task.id);
    const {id,input} = await interruptedRequest(current,'pause');
    const restarted = instance();
    expect((await restarted.get('session',snapshot.task.id)).execution?.status).toBe('paused');
    expect(await store.read<any>('conversation-requests',id)).toMatchObject({ status:'succeeded',messagesDelivered:true });
    expect((await restarted.action('session',snapshot.task.id,input)).execution?.status).toBe('paused');
  });

  it('keeps cancellation cleanup terminal across new epochs and allows only cleanup completion', async () => {
    const snapshot = await create();
    await service.setWorkerExecution('session',snapshot.task.id,{ status:'cancelled_cleanup_pending',epoch:2,phase:'settled' });
    await expect(service.setWorkerExecution('session',snapshot.task.id,{status:'running',epoch:3})).rejects.toMatchObject({code:'WORKER_FENCED'});
    await expect(service.setWorkerExecution('session',snapshot.task.id,{status:'running'},2)).rejects.toMatchObject({code:'WORKER_FENCED'});
    expect((await service.setWorkerExecution('session',snapshot.task.id,{status:'cancelled'})).status).toBe('cancelled');
  });
});
