import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { updateGlobalConfig } from '../../../infrastructure/runtime/config/config-store.js';
import { DATA_ROOT } from '../../../infrastructure/runtime/env.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { runCoordinator } from '../run-coordinator.js';
import { conversationGitService } from '../conversation-git/service.js';
import { sessionLiveBus } from '../session-live-bus.js';
import { runtimeFacade } from '../sidecar/runtime-facade.js';

type Message = { role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> };
let root: string;
let repository: string;
let sessionId: string;
let provider: http.Server;
let targetBefore: string;
let releaseChild: (() => void) | undefined;
let childHeld: boolean;
let asynchronous: boolean;
let holdForControl: boolean;
let parentToolResults: unknown[];
let childToolSets: string[][];
const privateTarget = 'TARGET_IMPLEMENTATION_MUST_STAY_IN_CHILD';
const privateSource = 'SOURCE_IMPLEMENTATION_MUST_STAY_IN_CHILD';
const resolution = `export const behavior = '${privateTarget} + ${privateSource}';\n`;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const decode = (content: unknown): Record<string, any> => {
  const value = typeof content === 'string' ? content : Array.isArray(content) ? content.map(item => item.text ?? '').join('') : JSON.stringify(content);
  try { return JSON.parse(value); } catch { return { text: value }; }
};

beforeEach(async () => {
  vi.stubEnv('SYNAX_AGENT_SESSION_IN_PROCESS', '1');
  vi.stubEnv('DATA_ROOT', DATA_ROOT);
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), 'synax-merge-worker-'));
  repository = path.join(root, 'repo');
  await mkdir(repository);
  git('init', '-b', 'main'); git('config', 'user.name', 'Merge Worker Test'); git('config', 'user.email', 'merge@example.test');
  await writeFile(path.join(repository, 'app.ts'), "export const behavior = 'base';\n");
  git('add', 'app.ts'); git('commit', '-m', 'base');
  git('checkout', '-b', 'feature/worker');
  await writeFile(path.join(repository, 'app.ts'), `export const behavior = '${privateSource}';\n`);
  git('commit', '-am', 'source');
  git('checkout', '-b', 'integration', 'main');
  await writeFile(path.join(repository, 'app.ts'), `export const behavior = '${privateTarget}';\n`);
  git('commit', '-am', 'target');
  targetBefore = git('rev-parse', 'integration');
  git('checkout', 'main');
  asynchronous = false; holdForControl = false; childHeld = false; parentToolResults = []; childToolSets = [];

  provider = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as { messages: Message[]; tools: Array<{ function: { name: string } }> };
      const names = input.tools?.map(tool => tool.function.name) ?? [];
      const child = names.some(name => name.startsWith('git_merge_worker_'));
      const toolMessages = input.messages.filter(message => message.role === 'tool');
      const results = toolMessages.map(message => decode(message.content));
      if (child) childToolSets.push(names);
      else parentToolResults.push(...results);
      let name: string | undefined;
      let args: unknown = {};
      if (!child && results.length === 0) {
        name = 'git_merge_create';
        args = { rootId: 'project-alpha', title: 'Dedicated merge worker', target: 'integration', sources: ['feature/worker'], strategy: 'merge_commit', checks: [
          { id: 'retains-both-behaviors', executable: process.execPath, args: ['-e', `const t=require('fs').readFileSync('app.ts','utf8');if(!t.includes('${privateTarget}')||!t.includes('${privateSource}'))process.exit(1);console.log('checks passed')`], timeoutMs: 10_000 },
        ] };
      } else if (child) {
        const sequence = ['inspect', 'prepare', 'files', ...(asynchronous ? ['report'] : []), 'read', 'read', 'read', 'read', 'resolve', 'continue', 'checks', 'finalize'];
        const operation = sequence[results.length];
        if (operation) name = `git_merge_worker_${operation}`;
        if (operation === 'report') args = { summary: 'Independent merge in progress; parent may continue.', joinMode: 'async' };
        if ((asynchronous || holdForControl) && operation === 'read' && !childHeld) {
          childHeld = true;
          await new Promise<void>(resolve => { releaseChild = resolve; });
        }
        const manifest = [...results].reverse().find(result => Array.isArray(result) || Array.isArray(result.files));
        const files = Array.isArray(manifest) ? manifest : manifest?.files;
        const fileId = files?.find((file: { conflicted: boolean }) => file.conflicted)?.id;
        if (operation === 'read') {
          const index = results.length - (asynchronous ? 4 : 3);
          args = { fileId, side: ['base', 'target', 'source', 'result'][index], offset: 0, limit: 48_000 };
        }
        if (operation === 'resolve') {
          const read = [...results].reverse().find(result => result.fileId && result.revision);
          args = { fileId: read?.fileId, expectedRevision: read?.revision, content: resolution, rationale: 'Preserve both branch behaviors.' };
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
        id: 'merge-fixture', object: 'chat.completion.chunk', model: 'fixture', created: 0, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if (name) {
        chunk({ tool_calls: [{ index: 0, id: `${child ? 'child' : 'parent'}-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        chunk({}, 'tool_calls');
      } else { chunk({ content: child ? 'Merge candidate verified and applied.' : 'Received the merge worker summary.' }); chunk({}, 'stop'); }
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  updateGlobalConfig({ defaultApiProviderId: 'openai', providerConnections: { openai: { providerId: 'openai', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, extra: { kind: 'api', apiFormat: 'openai', model: 'fixture' } } } }, 'merge-worker-test');
  sessionId = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'synax', prompt: 'Merge feature into integration.', workDir: repository, permissionTier: 'unrestricted', sessionMetadata: { mode: 'chat' } }).id;
});

afterEach(async () => {
  releaseChild?.(); releaseChild = undefined;
  if (sessionId) {
    await runCoordinator.interrupt(sessionId, 'Test cleanup').catch(() => undefined);
    for (const child of store.listSessionTree(sessionId).filter(child => child.id !== sessionId)) await runCoordinator.interrupt(child.id, 'Test cleanup').catch(() => undefined);
  }
  await runCoordinator.waitForIdle();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(['1', '0'])('executes the real Git resolution in a scoped child and renders only its anchor and summaries in the parent (in process: %s)', async (inProcess) => {
  vi.stubEnv('SYNAX_AGENT_SESSION_IN_PROCESS', inProcess);
  const events: unknown[] = [];
  const release = sessionLiveBus.subscribe(sessionId, event => { if (event.type === 'conversation_git_state') events.push(event); });
  try {
    const admitted = await runCoordinator.submitAsync(sessionId, { message: 'Merge feature into integration.' }, 'merge-blocking');
    await runCoordinator.waitForIdle();
    expect(store.getRun(admitted.run.id).status, JSON.stringify(store.listToolCalls(sessionId))).toBe('completed');
    await store.hydrateSession(sessionId, true);
    const tasks = await conversationGitService.list(sessionId);
    expect(tasks).toHaveLength(1);
    const snapshot = tasks[0];
    await store.hydrateSession(snapshot.execution!.childSessionId!, true);
    const child = store.getSession(snapshot.execution!.childSessionId!);
    expect(snapshot.mr.status, JSON.stringify({ execution: snapshot.execution, parent: store.listToolCalls(sessionId).map(call => ({ id: call.toolId, status: call.status, error: call.error, output: call.outputRef })),
      child: { status: child.status, error: child.blockedReason }, calls: store.listToolCalls(child.id).map(call => ({ id: call.toolId, status: call.status, error: call.error })) })).toBe('merged');
    expect(snapshot.execution?.status).toBe('completed');
    expect(child.parentSessionId).toBe(sessionId);
    expect(child.profileId).toBe('git-merge-worker');
    expect(childToolSets.length).toBeGreaterThanOrEqual(10);
    expect(childToolSets.every(names => names.every(name => name.startsWith('git_merge_worker_')))).toBe(true);
    expect(git('show', 'integration:app.ts') + '\n').toBe(resolution);
    expect(git('rev-parse', 'integration')).not.toBe(targetBefore);
    expect(store.listMessages(sessionId).filter(message => message.metadata.source === 'git_merge_task')).toHaveLength(1);
    expect(store.listMessages(child.id).some(message => message.metadata.source === 'git_merge_task')).toBe(false);
    expect(events.length).toBeGreaterThan(1);
    // The primary tool result is bounded metadata, never the child read/resolve transcript.
    expect(JSON.stringify(parentToolResults)).not.toContain('export const behavior');
    expect(store.listToolCalls(sessionId).map(call => call.toolId)).toEqual(['git.merge.create']);
  } finally { release(); }
}, 120_000);

it('releases the parent after an explicit async handoff while the child is still running', async () => {
  asynchronous = true;
  const admitted = await runCoordinator.submitAsync(sessionId, { message: 'Merge and report.' }, 'merge-async');
  await vi.waitFor(() => expect(childHeld, JSON.stringify({ parent: store.getRun(admitted.run.id).status,
    calls: store.listToolCalls(sessionId).map(call => ({ tool: call.toolId, status: call.status, error: call.error })),
    children: store.getSession(sessionId).childSessionIds.map(id => ({ id, status: store.getSession(id).status,
      calls: store.listToolCalls(id).map(call => ({ tool: call.toolId, status: call.status, error: call.error })) })) })).toBe(true), { timeout: 45_000 });
  await vi.waitFor(() => expect(store.getRun(admitted.run.id).status).toBe('completed'), { timeout: 10_000 });
  const [task] = await conversationGitService.list(sessionId);
  expect(task.execution?.joinMode).toBe('async');
  expect(git('rev-parse', 'integration')).toBe(targetBefore);
  expect(runCoordinator.isActive(task.execution!.childSessionId!)).toBe(true);
  releaseChild?.(); releaseChild = undefined;
  await runCoordinator.waitForIdle();
  const completed = await conversationGitService.get(sessionId, task.task.id);
  expect(completed.mr.status, JSON.stringify(store.listToolCalls(task.execution!.childSessionId!))).toBe('merged');
}, 90_000);

it.each(['1', '0'])('pauses at a durable fence, rejects late writes, and discards only the isolated candidate on cancel (in process: %s)', async (inProcess) => {
  vi.stubEnv('SYNAX_AGENT_SESSION_IN_PROCESS', inProcess);
  holdForControl = true;
  const parentRun = await runCoordinator.submitAsync(sessionId, { message: 'Merge and report.' }, 'merge-cancel');
  await vi.waitFor(() => expect(childHeld).toBe(true), { timeout: 45_000 });
  expect(store.getRun(parentRun.run.id).status).toBe('running');
  await store.hydrateSessionSummary(sessionId, true);
  const [task] = await conversationGitService.list(sessionId);
  const childId = task.execution!.childSessionId!;
  const worktree = task.mr.worktree!;
  const paused = await conversationGitService.action(sessionId, task.task.id, {
    action: 'pause', requestId: 'pause-once', expectedVersion: task.mr.version, expectedTaskRevision: task.task.revision,
  });
  expect(paused.execution?.status).toBe('paused');
  // UI control in the API process must release the parent's worker wait too.
  await vi.waitFor(async () => {
    await store.hydrateSessionSummary(sessionId, true);
    expect(store.getSession(sessionId).activeRunId).toBeNull();
    expect(store.getSession(sessionId).status).toBe('completed');
  }, { timeout: 15_000 });
  expect(runCoordinator.isActive(childId)).toBe(false);
  expect(git('rev-parse', 'integration')).toBe(targetBefore);
  const file = await conversationGitService.file(sessionId, task.task.id, paused.files.find(file => file.conflicted)!.id);
  await store.hydrateSessionSummary(childId, true);
  await expect(conversationGitService.workerSaveFile(childId, task.task.id, file.id, {
    requestId: 'late-write', expectedTaskRevision: paused.task.revision, expectedVersion: paused.mr.version,
    expectedRevision: file.revision, content: resolution, resolve: true,
  })).rejects.toMatchObject({ code: 'WORKER_FENCED' });
  const cancelled = await conversationGitService.action(sessionId, task.task.id, {
    action: 'cancel', requestId: 'cancel-once', expectedVersion: paused.mr.version, expectedTaskRevision: paused.task.revision,
  });
  expect(cancelled.execution?.status).toBe('cancelled');
  expect(cancelled.mr.status).toBe('cancelled');
  expect(await stat(worktree).then(() => true, () => false)).toBe(false);
  expect(git('rev-parse', 'integration')).toBe(targetBefore);
  expect(git('status', '--porcelain')).toBe('');
  // A repeated request repairs delivery; it cannot recreate a worker/worktree.
  const repeated = await conversationGitService.action(sessionId, task.task.id, {
    action: 'cancel', requestId: 'cancel-once', expectedVersion: paused.mr.version, expectedTaskRevision: paused.task.revision,
  });
  expect(repeated.execution?.status).toBe('cancelled');
  releaseChild?.(); releaseChild = undefined;
  await runCoordinator.waitForIdle();
  expect(git('rev-parse', 'integration')).toBe(targetBefore);
}, 120_000);

it('enforces a parent stop committed by another host even before the merge task receives a pause event', async () => {
  holdForControl = true;
  const parent = await runCoordinator.submitAsync(sessionId, { message: 'Merge and report.' }, 'merge-parent-stop');
  await vi.waitFor(() => expect(childHeld).toBe(true), { timeout: 45_000 });
  const [task] = await conversationGitService.list(sessionId);
  const childId = task.execution!.childSessionId!;
  const file = await conversationGitService.file(sessionId, task.task.id, task.files.find(file => file.conflicted)!.id);
  await runtimeFacade.controlCommand({ sessionId, requestId: 'stop-parent-write-fence', operation: 'stop_begin',
    payload: { runId: parent.run.id, reason: 'User stopped the controlling session.' } });
  // The domain record is deliberately still running. Its independent Git lease
  // must not bypass the controlling session's authoritative stop authority.
  expect((await conversationGitService.workerSnapshot(sessionId, task.task.id)).execution?.status).toBe('running');
  await expect(conversationGitService.workerSaveFile(childId, task.task.id, file.id, {
    requestId: 'write-after-parent-fence', expectedTaskRevision: task.task.revision, expectedVersion: task.mr.version,
    expectedRevision: file.revision, content: resolution, resolve: true,
  })).rejects.toMatchObject({ code: 'WORKER_FENCED' });
  expect(git('rev-parse', 'integration')).toBe(targetBefore);
  expect((await conversationGitService.file(sessionId, task.task.id, file.id)).result).toBe(file.result);
}, 90_000);
