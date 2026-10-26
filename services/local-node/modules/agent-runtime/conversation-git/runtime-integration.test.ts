import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as commands from '../tools/exec-async.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { sessionLiveBus } from '../session-live-bus.js';
import { toolRegistry } from '../tool-registry.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from '../__tests__/agent-runtime-fixtures.js';
import { conversationGitTools } from './tools.js';
import { conversationGitService } from './service.js';
import type { AgentRuntimeMessage } from '../contracts.js';

let root: string;
let repo: string;
let sessionId: string;
let requestCounter = 0;

const git = (...args: string[]) => execFileSync('git', args, {
  cwd: repo,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function commit(file: string, content: string, message = file) {
  writeFileSync(path.join(repo, file), content);
  git('add', '--', file);
  git('commit', '-m', message);
}

function source(name: string, content: string) {
  git('checkout', '-b', name, 'main');
  commit('app.ts', content, name);
  git('checkout', 'main');
}

function call(toolId: string, args: unknown, options: { runId?: string; stepId?: string } = {}) {
  return toolRegistry.execute(sessionId, toolId, args, {
    runId: options.runId ?? 'run-conversation-git',
    stepId: options.stepId ?? `step-${toolId}`,
    modelToolCallId: `model-call-${++requestCounter}`,
  });
}

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = mkdtempSync(path.join(os.tmpdir(), 'synax-runtime-conversation-git-'));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Runtime integration');
  git('config', 'user.email', 'runtime@example.test');
  commit('app.ts', 'export const value = 0;\n', 'base');
  git('branch', 'integration');
  source('feature/a', 'export const value = 1;\n');
  source('feature/b', 'export const value = 2;\n');
  const session = agentSessionRuntime.create({
    projectId: 'project-alpha',
    profileId: 'synax',
    prompt: 'Resolve the merge in this conversation.',
    workDir: repo,
    permissionTier: 'unrestricted',
  });
  sessionId = session.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (sessionId) store.reset();
  if (root) rmSync(root, { recursive: true, force: true });
  requestCounter = 0;
});

describe('registered conversation Git tools in the native runtime', { timeout: 60_000 }, () => {
  it('persists a resumed timeline after an API host reload while preserving the old message sequence', async () => {
    // This contract exercises Rust history, not the process guardian. Execute
    // real Git directly so process shutdown timing cannot mask sequence bugs.
    vi.spyOn(commands, 'runCommand').mockImplementation(async (executable, args, options = {}) => {
      const result = spawnSync(executable, args, { cwd: options.cwd, env: options.env, input: options.stdin, encoding: 'utf8', timeout: 30_000 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error,
        timedOut: false, stdoutTruncated: false, stderrTruncated: false,
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') };
    });
    const original = await conversationGitService.create(sessionId, { requestId: 'timeline-create', title: 'Resume timeline', target: 'integration', sources: ['feature/a'], strategy: 'merge_commit' });
    const old = store.getMessage(sessionId, original.task.messageId) as AgentRuntimeMessage & { sequence: number };
    const stopped = await conversationGitService.setWorkerExecution(sessionId, original.task.id, { status: 'paused', epoch: 1 });
    store.appendMessage({ id: 'follow-up', sessionId, runId: null, stepId: null, role: 'user', content: '继续原任务', metadata: {}, createdAt: new Date().toISOString() });
    await store.flushSession(sessionId);
    store.reset();
    await store.hydrateSessionSummary(sessionId, true);
    await conversationGitService.setWorkerExecution(sessionId, original.task.id, { status: 'running', epoch: 2 }, { epoch: stopped.epoch, revision: stopped.revision });
    const current = await conversationGitService.workerSnapshot(sessionId, original.task.id);
    const { runtimeFacade } = await import('../sidecar/runtime-facade.js');
    const messages = await runtimeFacade.listMessageHistory(sessionId) as Array<AgentRuntimeMessage & { sequence: number }>;
    const expired = messages.find(message => message.id === old.id)!;
    const resumed = messages.find(message => message.id === current.task.messageId)!;
    expect(expired.sequence).toBe(old.sequence);
    expect(expired.metadata.gitMergeTimeline).toMatchObject({ state: 'superseded', replacementMessageId: resumed.id });
    expect(resumed.sequence).toBeGreaterThan(messages.find(message => message.id === 'follow-up')!.sequence);
    expect(messages.filter(message => message.metadata.source === 'git_merge_task')).toHaveLength(2);
  }, 180_000);
  it('renders a durable domain task and reads/proposes through the real tool registry', async () => {
    const visible = toolRegistry.listForSession(sessionId).map(tool => tool.id);
    expect(visible).toEqual(expect.arrayContaining(conversationGitTools.map(tool => tool.id)));
    expect(visible).toContain('git.merge.create');
    expect(visible).toContain('git.merge.analyze');
    expect(visible).toContain('git.merge.read');
    expect(visible).toContain('git.merge.propose');

    const live: unknown[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, event => {
      if (event.type === 'conversation_git_messages') live.push(event);
    });
    try {
      const created = await conversationGitService.create(sessionId, {
        requestId: 'domain-integration-create',
        rootId: 'project-alpha',
        title: 'Conversation conflict',
        target: 'integration',
        sources: ['feature/a', 'feature/b'],
        strategy: 'merge_commit',
      });
      expect(created.mr.status).toBe('draft');
      const taskId = created.task.id;
      const createMessage = store.listMessages(sessionId).filter(message => message.metadata.source === 'git_merge_task');
      expect(createMessage).toHaveLength(1);
      expect(createMessage[0].content).toContain(taskId);
      expect(createMessage[0].metadata.gitMergeTask).toMatchObject({ objectId: taskId, sessionId });

      const analysis = await conversationGitService.action(sessionId, taskId, { action: 'prepare', requestId: 'domain-integration-prepare',
        expectedVersion: created.mr.version, expectedTaskRevision: created.task.revision });
      expect(analysis.mr.status).toBe('conflicted');
      expect(analysis.files.filter(file => file.conflicted)).toHaveLength(1);

      const read = await call('git.merge.read', { objectId: taskId });
      expect(read.record.status).toBe('completed');
      const readResult = read.toolResult!.result as { mr: { status: string; version: number }; taskRevision: number; files: Array<{ id: string; conflicted: boolean }> };
      const fileId = readResult.files.find(file => file.conflicted)!.id;
      const fileRead = await call('git.merge.read', { objectId: taskId, fileId, side: 'result', offset: 0, limit: 4096 });
      expect(fileRead.record.status).toBe('completed');
      const exact = fileRead.toolResult!.result as { fileId: string; revision: string; content: string; truncated: boolean };
      expect(exact.fileId).toBe(fileId);
      expect(exact.content).toContain('<<<<<<<');
      expect(exact.truncated).toBe(false);

      const proposed = await call('git.merge.propose', {
        objectId: taskId,
        fileId,
        revision: exact.revision,
        content: 'export const value = 3;\n',
        rationale: '保留两个分支的更新意图，使用统一的最终值。',
      });
      expect(proposed.record.status).toBe('completed');
      expect(proposed.toolResult?.result).toMatchObject({ objectId: taskId, fileId });
      expect(store.listMessages(sessionId).filter(message => message.metadata.source === 'git_merge_task')).toHaveLength(1);
      expect(store.listMessages(sessionId).filter(message => message.metadata.source === 'git_merge_receipt')).toHaveLength(1);
      expect(live).toHaveLength(2);
      expect(live.every(event => (event as { messages: unknown[] }).messages.length <= 2)).toBe(true);
      expect(store.listToolCalls(sessionId).map(call => call.toolId)).toEqual([
        'git.merge.read', 'git.merge.read', 'git.merge.propose',
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the profile and write gate visible while denying an unapproved profile', async () => {
    const tool = toolRegistry.listForSession(sessionId).find(item => item.id === 'git.merge.analyze');
    expect(tool).toMatchObject({ category: 'write', internalGate: 'write', mutability: 'write' });
    const planning = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'planner', prompt: 'Plan only.', workDir: repo });
    const result = await toolRegistry.execute(planning.id, 'git.merge.analyze', {
      objectId: 'missing-task', expectedVersion: 1, expectedTaskRevision: 1,
    });
    expect(result.record.status).toBe('failed');
    expect(result.record.error).toMatch(/not available to profile planner/i);
    expect(store.listToolCalls(planning.id)).toHaveLength(1);
  });
});
