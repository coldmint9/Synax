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

it('continues a paused merge after the parent completed without starting another parent model run', async () => {
  holdForControl = true;
  const parentRun = await runCoordinator.submitAsync(sessionId, { message: 'Merge and report.' }, 'merge-pause-resume');
  await vi.waitFor(() => expect(childHeld).toBe(true), { timeout: 45_000 });
  const [task] = await conversationGitService.list(sessionId);
  const paused = await conversationGitService.action(sessionId, task.task.id, {
    action: 'pause', requestId: 'pause-resume-test', expectedVersion: task.mr.version, expectedTaskRevision: task.task.revision,
  });
  await runCoordinator.waitForSessionIdle(sessionId);
  expect(store.getRun(parentRun.run.id).status).toBe('completed');
  const parentRunIds = store.listRuns(sessionId).map(run => run.id);
  holdForControl = false;
  releaseChild?.(); releaseChild = undefined;
  const resumed = await conversationGitService.action(sessionId, task.task.id, {
    action: 'resume', requestId: 'resume-after-parent-complete', expectedVersion: paused.mr.version, expectedTaskRevision: paused.task.revision,
  });
  expect(resumed.execution?.joinMode).toBe('async');
  await vi.waitFor(async () => {
    const state = await conversationGitService.workerSnapshot(sessionId, task.task.id);
    const id = state.execution!.childSessionId!;
    expect(state.execution?.status, JSON.stringify({execution:state.execution, session:store.getSession(id), runs:store.listRuns(id), calls:store.listToolCalls(id)})).toBe('completed');
  }, { timeout: 30_000 });
  await runCoordinator.waitForIdle();
  const complete = await conversationGitService.get(sessionId, task.task.id);
  expect(complete.execution?.status, JSON.stringify({ execution: complete.execution,
    calls: store.listToolCalls(complete.execution!.childSessionId!).map(call => ({ toolId: call.toolId, status: call.status, error: call.error })) })).toBe('completed');
  expect(complete.mr.status).toBe('merged');
  expect(store.listRuns(sessionId).map(run => run.id)).toEqual(parentRunIds);
  expect(git('show', 'integration:app.ts') + '\n').toBe(resolution);
}, 120_000);

it('fences an idle connected provider, stops only its child, and releases the blocked parent', async () => {
  vi.stubEnv('SYNAX_MERGE_WORKER_IDLE_MS','8000');
  holdForControl = true;
  const admitted = await runCoordinator.submitAsync(sessionId, {message:'Merge and report.'}, 'merge-watchdog');
  await vi.waitFor(()=>expect(childHeld).toBe(true),{timeout:45_000});
  const [task] = await conversationGitService.list(sessionId);
  await vi.waitFor(async()=>expect((await conversationGitService.workerSnapshot(sessionId,task.task.id)).execution?.status).toBe('recovery_required'),{timeout:20_000});
  await vi.waitFor(()=>expect(runCoordinator.isActive(task.execution!.childSessionId!)).toBe(false),{timeout:15_000});
  await runCoordinator.waitForSessionIdle(sessionId);
  expect(store.getRun(admitted.run.id).status).toBe('completed');
  expect(git('rev-parse','integration')).toBe(targetBefore);
},90_000);
