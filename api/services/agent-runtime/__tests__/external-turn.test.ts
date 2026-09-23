import os from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptRuntimeRun } from '../run-admission.js';
import { ExternalTurn } from '../backends/external-turn.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { interactionService } from '../interaction-service.js';
import { permissionPolicy } from '../permission-policy.js';
beforeEach(() => { resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });
const create = () => agentSessionRuntime.create({ projectId: 'external-test', profileId: 'synax', prompt: 'Test', backendId: 'codex', workDir: os.tmpdir() });

describe('external native turn bridge', () => {
  it('keeps a native permission request live and never treats it as a Synax resume', async () => {
    const session = create(); const turn = new ExternalTurn(session.id, 'codex', {});
    const tool = turn.tool('native-command', 'commandExecution', { command: 'node example.js' }, 'shell');
    const pending = turn.permission(tool, 'Approve native execution?', undefined, true);
    const decision = agentRuntimeStore.listPermissions(session.id)[0];
    expect(agentRuntimeStore.getSession(session.id).status).toBe('waiting_permission');
    permissionPolicy.reply(session.id, decision.id, 'always', undefined, false);
    expect(turn.replyPermission(decision.id, 'always')).toBe(true);
    expect(await pending).toBe('always');
    expect(agentRuntimeStore.getSession(session.id).status).toBe('running');
    turn.result('native-command', 'ok'); await turn.finish();
  });
  it('uses persistent forms but routes their result back to the external agent', async () => {
    const session = create(); const turn = new ExternalTurn(session.id, 'codex', {});
    const pending = turn.ask('native-question', [{ id: 'q0', type: 'text', label: 'Which file?', required: true, allowOther: false }]);
    const question = interactionService.pending(session.id)!;
    interactionService.reply(session.id, question.id, { revision: 1, action: 'submit', answers: { q0: 'README.md' } });
    expect(turn.replyInput(question.id)).toBe(true);
    expect(await pending).toMatchObject({ answers: { q0: 'README.md' } });
    expect(agentRuntimeStore.getRun(turn.run.id).status).toBe('running');
    turn.delta('Read complete.'); await turn.finish();
  });
});

describe('native approval authority and terminal bookkeeping', () => {
  it('rejects unsupported always replies without resolving or broadening the permission', async () => {
    const session = create(); const turn = new ExternalTurn(session.id, 'codex', {});
    const pending = turn.permission(turn.tool('restricted', 'commandExecution', { command: 'echo test' }), 'Only once');
    const permission = agentRuntimeStore.listPermissions(session.id)[0];
    expect(() => permissionPolicy.reply(session.id, permission.id, 'always', undefined, false)).toThrow('not supported');
    expect(agentRuntimeStore.listPermissions(session.id)[0].resolvedAt).toBeNull();
    turn.cancelPending(); expect(await pending).toBe('reject');
    await turn.finish('Interrupted', true);
    expect(agentRuntimeStore.listToolCalls(session.id).every(tool => tool.status !== 'running')).toBe(true);
  });
  it('finishes the user-input tool after consuming the persistent answer', async () => {
    const session = create(); const turn = new ExternalTurn(session.id, 'codex', {});
    const pending = turn.ask('question', [{ id: 'q0', type: 'text', label: 'Name?', required: true, allowOther: false }]);
    const question = interactionService.pending(session.id)!;
    interactionService.reply(session.id, question.id, { revision: 1, action: 'submit', answers: { q0: 'example' } });
    turn.replyInput(question.id); await pending; await turn.finish();
    expect(agentRuntimeStore.listToolCalls(session.id)[0].status).toBe('completed');
  });
});

it('never treats a legacy native-turn usage aggregate as the current model context', async () => {
  const session = create(); const turn = new ExternalTurn(session.id, 'codex', {});
  turn.usage({ inputTokens: 41000, outputTokens: 309 }); await turn.finish();
  const stats = agentRuntimeStore.getSessionStats(session.id);
  expect(stats.usage.self.total).toBe(41309);
  expect(stats.context.inputTokens).toBeNull();
  expect(stats.contextLimitKnown).toBe(false);
});

it('a native Continue control does not replay the original session task prompt', async () => {
  const session = create();
  agentRuntimeStore.updateSession(session.id, { prompt: 'Create an initial delivery artifact exactly once.' });
  agentRuntimeStore.updateSessionMetadata(session.id, { nativeBackend: { id: 'codex', sessionId: 'existing-native-thread' } });
  const turn = new ExternalTurn(session.id, 'codex', {});
  expect(turn.message).toMatch(/^Continue the existing task/);
  expect(turn.message).not.toContain('Create an initial delivery artifact');
  expect(agentRuntimeStore.listMessages(session.id).at(-1)?.metadata.source).toBe('codex_continue');
  await turn.finish();
});

it('attaches the admitted request identity before emitting an external input', async () => {
  const session = create();
  const input = { message: '同一条输入' };
  const accepted = acceptRuntimeRun(session.id, input, 'external-identity');
  const turn = new ExternalTurn(session.id, 'codex', { ...input, acceptedRunId: accepted.run.id });
  const user = agentRuntimeStore.listMessages(session.id).find((message) => message.role === 'user');
  expect(user?.metadata.requestId).toBe('external-identity');
  expect(user?.runId).toBe(accepted.run.id);
  await turn.finish();
});
