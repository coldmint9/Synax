import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { sessionLiveBus } from '../session-live-bus.js';
import { toolRegistry } from '../tool-registry.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from '../__tests__/agent-runtime-fixtures.js';
import { conversationGitTools } from './tools.js';

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
  if (sessionId) store.reset();
  if (root) rmSync(root, { recursive: true, force: true });
  requestCounter = 0;
});

describe('registered conversation Git tools in the native runtime', { timeout: 60_000 }, () => {
  it('runs create → analyze → read → propose through the real tool registry and emits one anchor', async () => {
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
      const created = await call('git.merge.create', {
        rootId: 'project-alpha',
        title: 'Conversation conflict',
        target: 'integration',
        sources: ['feature/a', 'feature/b'],
        strategy: 'merge_commit',
      });
      expect(created.record.status, JSON.stringify(created)).toBe('completed');
      expect(created.record.category).toBe('task');
      expect(created.toolResult?.result).toMatchObject({ mr: { status: 'draft' } });
      const createdResult = created.toolResult!.result as { objectId: string; taskRevision: number; mr: { version: number } };
      const taskId = createdResult.objectId;
      const createMessage = store.listMessages(sessionId).filter(message => message.metadata.source === 'git_merge_task');
      expect(createMessage).toHaveLength(1);
      expect(createMessage[0].content).toContain(taskId);
      expect(createMessage[0].metadata.gitMergeTask).toMatchObject({ objectId: taskId, sessionId });

      const analyzed = await call('git.merge.analyze', {
        objectId: taskId,
        expectedVersion: createdResult.mr.version,
        expectedTaskRevision: createdResult.taskRevision,
      });
      expect(analyzed.record.status).toBe('completed');
      expect(analyzed.record.mutability).toBe('write');
      expect(analyzed.permission?.action ?? 'allow').toBe('allow');
      const analysis = analyzed.toolResult!.result as { mr: { status: string; version: number }; taskRevision: number; files: Array<{ id: string; conflicted: boolean }> };
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
        'git.merge.create', 'git.merge.analyze', 'git.merge.read', 'git.merge.read', 'git.merge.propose',
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
