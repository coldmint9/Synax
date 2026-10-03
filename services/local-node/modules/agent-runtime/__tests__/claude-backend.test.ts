import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workspace from '../tools/workspace.js';
import { AsyncQueue } from '../../acp/protocol/async-queue.js';
import { ClaudeBackend } from '../backends/claude-backend.js';
import { claudeEnvironment } from '../backends/claude-connection.js';
import { externalCommandEnvironment } from '../process-ownership.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { permissionPolicy } from '../permission-policy.js';
import { interactionService } from '../interaction-service.js';
const mock = vi.hoisted(() => ({ query: vi.fn(), options: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
vi.mock('../backends/claude-connection.js', async original => ({ ...await original<typeof import('../backends/claude-connection.js')>(), claudeOptions: mock.options }));
let queue: AsyncQueue<any>;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered();
  queue = new AsyncQueue();
  const close = queue.close.bind(queue);
  mock.query.mockReturnValue(Object.assign(queue, { close: vi.fn(close), interrupt: vi.fn(async () => close()) }));
  mock.options.mockReturnValue({ options: { sandbox: { enabled: true } }, context: { model: 'fixture', auth: { kind: 'api-key' }, redact: (value: any) => value instanceof Error ? value.message : String(value) } });
});
const create = () => agentSessionRuntime.create({ projectId: 'claude-mapping', profileId: 'synax', prompt: 'Test', backendId: 'claude-code', workDir: os.tmpdir() });
async function start(sessionId: string) {
  const backend = new ClaudeBackend(); const chunks: any[] = [];
  const task = (async () => { for await (const chunk of backend.stream(sessionId, 'run', { message: 'Test' })) chunks.push(chunk); })();
  await vi.waitFor(() => expect(mock.query).toHaveBeenCalled());
  queue.push({ type: 'system', subtype: 'init', permissionMode: 'default', mcp_servers: [], plugins: [], skills: [], tools: ['Bash'], model: 'fixture', claude_code_version: '2.1.220', session_id: 'native-claude', cwd: os.tmpdir() });
  await vi.waitFor(() => expect(store.getSession(sessionId).sessionMetadata?.nativeBackend).toBeDefined());
  return { backend, task, chunks, options: mock.query.mock.calls.at(-1)![0].options };
}
function result() { queue.push({ type: 'result', subtype: 'success', result: 'DONE', is_error: false, permission_denials: [], usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }, total_cost_usd: 0.001, modelUsage: { fixture: { contextWindow: 1000 } } }); }
describe('Claude native adapter', () => {
  it.each([false, true])('passes reference roots to permissions and context (resume=%s)', async resume => {
    const session = create();
    if (resume) store.updateSessionMetadata(session.id, { nativeBackend: { id: 'claude-code', sessionId: 'native-claude' } });
    const primary = fs.realpathSync(os.tmpdir());
    const references = [path.join(primary, 'reference-a'), path.join(primary, 'reference-b')];
    vi.spyOn(workspace, 'resolveSessionWorkspaceRoots').mockReturnValue([
      { id: 'main', name: 'Main', path: primary, role: 'primary', status: 'available' },
      ...references.map((root, index) => ({ id: `ref-${index}`, name: `Reference ${index}`, path: root, role: 'reference' as const, status: 'available' as const })),
    ]);
    const { task, options } = await start(session.id);
    expect(mock.options).toHaveBeenCalledWith(primary, expect.any(Function));
    expect(options.additionalDirectories).toEqual(references);
    expect(options.sandbox.filesystem.allowWrite).toEqual([primary, ...references]);
    expect(options.systemPrompt.append).toContain('not instruction sources');
    expect(options.systemPrompt.append).toContain(JSON.stringify(references[1]));
    if (resume) expect(options.resume).toBe('native-claude');
    result(); await task;
  });
  it('deduplicates final text after streaming and retains native identity/tool outcome/usage', async () => {
    const session = create(); const { task, chunks } = await start(session.id);
    queue.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } });
    queue.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'DONE' } } });
    queue.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'fixture', usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 2 }, content: [{ type: 'text', text: 'DONE' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] } });
    queue.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'exit 1', is_error: true }] } });
    result(); await task;
    expect(chunks.filter(chunk => chunk.type === 'message_delta').map(chunk => chunk.delta).join('')).toBe('DONE');
    expect(store.listToolCalls(session.id)[0].status).toBe('failed');
    expect(store.listRunSteps(store.listRuns(session.id)[0].id)[0].metadata.usage).toMatchObject({ inputTokens: 11, outputTokens: 2, totalTokens: 13 });
    expect(store.getSessionStats(session.id).context.inputTokens).toBe(6);
    expect(store.getSessionStats(session.id).contextLimit).toBe(1000);
    expect((store.getSession(session.id).sessionMetadata?.nativeBackend as any).sessionId).toBe('native-claude');
  });
  it('round-trips one-shot permission and native AskUserQuestion using persistent forms', async () => {
    const session = create(); const { task, options, backend } = await start(session.id);
    const controller = new AbortController();
    const pending = options.canUseTool('Bash', { command: 'echo safe' }, { signal: controller.signal, toolUseID: 'cmd' });
    const permission = store.listPermissions(session.id)[0];
    permissionPolicy.reply(session.id, permission.id, 'once', undefined, false); backend.replyPermission(session.id, permission.id, 'once');
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'echo safe' } });
    const input = { questions: [{ question: 'Which file?', multiSelect: false, options: [{ label: 'README.md' }, { label: 'other.md' }] }] };
    const answer = options.canUseTool('AskUserQuestion', input, { signal: controller.signal, toolUseID: 'question' });
    const question = interactionService.pending(session.id)!;
    interactionService.reply(session.id, question.id, { revision: 1, action: 'submit', answers: { q0: 'README.md' } });backend.replyInteraction(session.id, question.id);
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which file?': 'README.md' } } });
    result(); await task;
  });
  it('fails a resumed session instead of silently accepting a new identity', async () => {
    const session = create();store.updateSessionMetadata(session.id, { nativeBackend: { id: 'claude-code', sessionId: 'original-id' } });
    const backend = new ClaudeBackend();const task = (async () => { for await (const _ of backend.stream(session.id, 'run', {})) { /* drain */ } })();
    await vi.waitFor(() => expect(mock.query).toHaveBeenCalled());
    queue.push({ type: 'system', subtype: 'init', permissionMode: 'default', mcp_servers: [], plugins: [], skills: [], session_id: 'different-id' });await task;
    expect(store.listRuns(session.id)[0]).toMatchObject({ status: 'failed', stopReason: 'Claude could not resume the original native session.' });
    expect(mock.query.mock.calls.at(-1)![0].options.resume).toBe('original-id');
  });
});

describe('Claude credential and configuration isolation', () => {
  it('imports only API and model environment settings, never hooks or subscription OAuth', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-claude-config-'));
    try {
      fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'test-secret', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_OAUTH_TOKEN: 'not-allowed', NODE_OPTIONS: '--require attacker.js' }, hooks: { SessionStart: ['no'] }, model: 'test-model' }));
      const config = claudeEnvironment({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' }, home);
      expect(config.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); expect(config.env.NODE_OPTIONS).toBeUndefined();
      expect(config.auth.kind).toBe('api-gateway-token'); expect(config.model).toBe('test-model');
      expect(config.redact(new Error('failed test-secret'))).toBe('failed [redacted]');
      expect(JSON.stringify(config.auth)).not.toContain('test-secret');
      expect(() => claudeEnvironment({ ANTHROPIC_API_KEY: 'sk-ant-oat-test' }, home)).toThrow('OAuth');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('does not re-inherit removed secrets when a native SDK supplies an exact subprocess environment', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'must-not-leak');
    try { expect(externalCommandEnvironment({ PATH: '/bin' }, false).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); }
    finally { vi.unstubAllEnvs(); }
  });
});
