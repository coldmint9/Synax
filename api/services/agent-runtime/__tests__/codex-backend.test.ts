import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workspace from '../tools/workspace.js';
import { backendBindingSchema } from '../backends/backend-contracts.js';
import { CodexBackend } from '../backends/codex-backend.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { permissionPolicy } from '../permission-policy.js';
import { interactionService } from '../interaction-service.js';
const mock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../backends/codex-connection.js', async original => ({ ...await original<typeof import('../backends/codex-connection.js')>(), openCodex: mock.open }));
class FakeRpc {
  notify = (_event: { method: string; params?: unknown }) => {};
  reverse = async (_method: string, _params: unknown): Promise<unknown> => ({});
  end!: () => void;
  closed = new Promise<void>(resolve => { this.end = resolve; });
  stop = vi.fn(async () => { this.end(); });
  onNotification(listener: typeof this.notify) { this.notify = listener; }
  onRequest(handler: typeof this.reverse) { this.reverse = handler; }
  emit(method: string, params: Record<string, unknown>) { this.notify({ method, params: { threadId: 'native-thread', ...params } }); }
  request = vi.fn(async (method: string) => {
    if (method === 'thread/start' || method === 'thread/resume') {
      this.emit('item/agentMessage/delta', { turnId: 'old-turn', delta: 'OLD' });
      return { thread: { id: 'native-thread' }, model: 'fixture', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', networkAccess: false } };
    }
    if (method === 'turn/start') this.emit('turn/started', { turn: { id: 'new-turn' } });
    if (method === 'turn/interrupt') this.emit('turn/completed', { turn: { id: 'new-turn', status: 'interrupted' } });
    return { turn: { id: 'new-turn' } };
  });
}
let rpc: FakeRpc;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); rpc = new FakeRpc();
  mock.open.mockResolvedValue({ rpc, config: {}, version: 'fixture', isolated: true });
});
const create = () => agentSessionRuntime.create({ projectId: 'codex-mapping', profileId: 'synax', prompt: 'Test', backendId: 'codex', workDir: os.tmpdir() });
async function start(sessionId: string) {
  const backend = new CodexBackend(); const chunks: any[] = [];
  const task = (async () => { for await (const chunk of backend.stream(sessionId, 'run', { message: 'Test' })) chunks.push(chunk); })();
  await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()));
  return { backend, chunks, task };
}
describe('Codex native protocol mapping', () => {
  it.each([false, true])('uses the same roots for thread and turn policies (resume=%s)', async resume => {
    const session = create();
    if (resume) store.updateSessionMetadata(session.id, { nativeBackend: { id: 'codex', sessionId: 'native-thread' } });
    const primary = fs.realpathSync(os.tmpdir());
    const references = [path.join(primary, 'reference-a'), path.join(primary, 'reference-b')];
    const roots = [
      { id: 'main', name: 'Main', path: primary, role: 'primary' as const, status: 'available' as const },
      ...references.map((root, index) => ({ id: `ref-${index}`, name: `Reference ${index}`, path: root, role: 'reference' as const, status: 'available' as const })),
    ];
    vi.spyOn(workspace, 'resolveSessionWorkspaceRoots').mockReturnValue(roots);
    const binding = { version: 1, id: 'codex', model: null, workDir: primary };
    expect(backendBindingSchema.parse(binding)).toEqual(binding);
    expect(backendBindingSchema.parse({ ...binding, workspaceRoots: roots }).workspaceRoots).toEqual(roots);
    const { task } = await start(session.id);
    expect(rpc.request).toHaveBeenCalledWith(resume ? 'thread/resume' : 'thread/start', expect.objectContaining({
      cwd: primary, approvalPolicy: 'untrusted', developerInstructions: expect.stringContaining('not instruction sources'),
      config: { sandbox_workspace_write: { writable_roots: [primary, ...references], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } },
    }));
    expect(rpc.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [primary, ...references], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    }));
    rpc.emit('turn/completed', { turn: { id: 'new-turn', status: 'completed' } }); await task;
  });
  it('cleans native background terminals before closing the protocol on an interrupt', async () => {
    const session = create(); const { task, backend } = await start(session.id);
    await backend.interrupt(session.id); await task;
    expect(rpc.request).toHaveBeenCalledWith('thread/backgroundTerminals/clean', { threadId: 'native-thread' }, 5000);
    const cleanIndex = rpc.request.mock.calls.findIndex(([method]) => method === 'thread/backgroundTerminals/clean');
    expect(rpc.request.mock.invocationCallOrder[cleanIndex]).toBeLessThan(rpc.stop.mock.invocationCallOrder[0]);
    expect(store.listRuns(session.id)[0].status).toBe('interrupted');
  });

  it('closes the stream but blocks the next Run if process cleanup cannot be confirmed', async () => {
    const session = create(); const { task } = await start(session.id);
    rpc.stop.mockRejectedValue(new Error('Process group is still alive.'));
    const rejection = expect(task).rejects.toThrow('still alive');
    rpc.emit('turn/completed', { turn: { id: 'new-turn', status: 'completed' } });
    await rejection;
    expect(store.getSession(session.id).sessionMetadata?.runtimeControl).toMatchObject({ state: 'unconfirmed', reason: 'Process group is still alive.' });
  });

  it('filters old turns, maps denied/failed tools, and reports usage deltas rather than thread totals', async () => {
    const session = create(); store.updateSessionMetadata(session.id, { nativeBackend: { id: 'codex', sessionId: 'native-thread', totalUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } });
    const { task, chunks } = await start(session.id);
    rpc.emit('turn/completed', { turn: { id: 'old-turn', status: 'completed' } });
    rpc.emit('item/agentMessage/delta', { turnId: 'old-turn', delta: 'ALSO OLD' });
    rpc.emit('item/agentMessage/delta', { turnId: 'new-turn', delta: 'CURRENT' });
    for (const [id, status, exitCode] of [['denied', 'declined', null], ['failed', 'completed', 1]]) {
      rpc.emit('item/completed', { turnId: 'new-turn', item: { id, type: 'commandExecution', status, exitCode, aggregatedOutput: 'fixture' } });
    }
    rpc.emit('thread/tokenUsage/updated', { turnId: 'new-turn', tokenUsage: { total: { inputTokens: 145, outputTokens: 18, totalTokens: 163 }, last: { inputTokens: 20, outputTokens: 8, totalTokens: 28 }, modelContextWindow: 1000 } });
    rpc.emit('unknown/event', { token: 'SHOULD_NOT_PERSIST' });
    rpc.emit('turn/completed', { turn: { id: 'new-turn', status: 'completed' } }); await task;
    expect(chunks.filter(c => c.type === 'message_delta').map(c => c.delta)).toEqual(['CURRENT']);
    expect(store.listToolCalls(session.id).map(tool => tool.status)).toEqual(['denied', 'failed']);
    expect(store.listRunSteps(store.listRuns(session.id)[0].id)[0].metadata.usage).toMatchObject({ inputTokens: 45, outputTokens: 8, totalTokens: 53 });
    const stats = store.getSessionStats(session.id, { configuredContextLimit: 9999 });
    expect(stats.context.inputTokens).toBe(20);
    expect(stats.usage.self.input).toBe(45);
    expect(stats.contextLimit).toBe(1000);
    expect(JSON.stringify(chunks)).not.toContain('SHOULD_NOT_PERSIST');
  });
  it('round-trips native approvals and questions through persistent Synax records', async () => {
    const session = create(); const { task, backend } = await start(session.id);
    const pending = rpc.reverse('item/commandExecution/requestApproval', { threadId: 'native-thread', turnId: 'new-turn', itemId: 'command', command: 'echo hello', availableDecisions: ['accept', 'cancel'] });
    const decision = store.listPermissions(session.id)[0];
    expect(decision.metadata.allowedReplies).toEqual(['once', 'reject']);
    permissionPolicy.reply(session.id, decision.id, 'reject', undefined, false); backend.replyPermission(session.id, decision.id, 'reject');
    expect(await pending).toEqual({ decision: 'cancel' });
    const answer = rpc.reverse('item/tool/requestUserInput', { threadId: 'native-thread', turnId: 'new-turn', itemId: 'question', questions: [{ id: 'native-question', question: 'Which file?', options: [{ label: 'README.md' }] }] });
    const interaction = interactionService.pending(session.id)!;
    interactionService.reply(session.id, interaction.id, { revision: 1, action: 'submit', answers: { q0: 'README.md' } }); backend.replyInteraction(session.id, interaction.id);
    expect(await answer).toEqual({ answers: { 'native-question': { answers: ['README.md'] } } });
    rpc.emit('turn/completed', { turn: { id: 'new-turn', status: 'completed' } }); await task;
  });
});
