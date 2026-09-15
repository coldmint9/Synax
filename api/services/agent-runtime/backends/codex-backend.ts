import { validateInputMedia } from '../media-capabilities.js';
import { codexMediaInput } from '../media-backend-input.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../../../lib/env.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { ExternalTurn } from './external-turn.js';
import { openCodex, object, string, array, type Json } from './codex-connection.js';
import { withDeadline } from '../managed-process.js';
import type { StdioRpc } from './stdio-rpc.js';
import type { BackendAdapter } from './backend-contracts.js';
import type { StreamTurnRequest, AgentRunStreamChunk, PermissionReply } from '../contracts.js';
import type { HumanQuestion } from '../control-contracts.js';

interface Active { turn: ExternalTurn; rpc?: StdioRpc; threadId?: string; turnId?: string; task: Promise<void>; controller: AbortController; stopTask?: Promise<void>; startingTurn?: Promise<unknown>; completion?: Promise<Json>; nativeEnded?: boolean }
export class CodexBackend implements BackendAdapter {
  private readonly active = new Map<string, Active>();
  async *stream(sessionId: string, _mode: string, input: StreamTurnRequest, signal?: AbortSignal): AsyncGenerator<AgentRunStreamChunk> {
    if (this.active.has(sessionId)) throw new Error('Codex session is already active.');
    if (input.reasoningEffort === 'max') throw new Error('Codex does not support max effort; choose a supported CLI effort.');
    if (input.maxSteps || input.maxTokens || input.temperature !== undefined) throw new Error('Codex controls its own agent-loop limits; these Native Synax overrides are unsupported.');
    if(input.contentParts?.some(p=>p.type!=='text'))await validateInputMedia(sessionId,input);
    const turn = new ExternalTurn(sessionId, 'codex', input);
    const controller = new AbortController();
    const entry: Active = { turn, controller, task: Promise.resolve() };
    this.active.set(sessionId, entry);
    const abort = () => { controller.abort(); void this.stop(entry).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    entry.task = this.run(entry, input).catch(error => turn.finish(error instanceof Error ? error.message : String(error), controller.signal.aborted))
      .finally(async () => {
        try { if (entry.stopTask) await entry.stopTask; else if (entry.rpc) await entry.rpc.stop(); }
        catch (error) { turn.cleanupUnconfirmed(error); throw error; }
        finally { try { if (entry.rpc) await entry.rpc.stop(); } finally { turn.queue.close(); } }
      });
    void entry.task.catch(() => {}); // The generator rethrows after draining terminal events.
    try { yield* turn.queue; }
    finally {
      try { await entry.task; }
      finally { signal?.removeEventListener('abort', abort); this.active.delete(sessionId); }
    }
  }
  private async run(entry: Active, input: StreamTurnRequest): Promise<void> {
    const turn = entry.turn;
    await turn.captureBaseline();
    const session = store.getSession(turn.sessionId);
    const native = object(session.sessionMetadata?.nativeBackend);
    const options = object(session.sessionMetadata?.backendOptions);
    const connection = await openCodex(turn.workDir, options.inheritCliTools === true, entry.controller.signal);
    entry.rpc = connection.rpc;
    if (entry.controller.signal.aborted) throw new Error('Codex execution interrupted.');
    let acceptingTurn = false;
    let totalUsage: Json | undefined;
    let usageBaseline: Json | undefined = native.id === 'codex' ? (Object.keys(object(native.totalUsage)).length ? object(native.totalUsage) : undefined) : {};
    let complete!: (value: Json) => void;
    const completion = new Promise<Json>(resolve => { complete = resolve; });
    entry.completion = completion;
    entry.rpc.onNotification(event => {
      const params = object(event.params);
      if (params.threadId && params.threadId !== entry.threadId) return;
      if (event.method === 'turn/started') { if (acceptingTurn) entry.turnId = string(object(params.turn).id); return; }
      const eventTurnId = params.turnId ?? object(params.turn).id;
      if (!acceptingTurn || !entry.turnId || (eventTurnId && eventTurnId !== entry.turnId)) return;
      switch (event.method) {
        case 'item/agentMessage/delta': turn.delta(string(params.delta)); break;
        case 'item/reasoning/summaryTextDelta': case 'item/reasoning/textDelta': turn.delta(string(params.delta), true); break;
        case 'item/started': this.item(turn, object(params.item), false); break;
        case 'item/completed': this.item(turn, object(params.item), true); break;
        case 'item/commandExecution/outputDelta': turn.progress('Command output', { itemId: params.itemId, delta: params.delta }); break;
        case 'thread/tokenUsage/updated': {
          const usage = object(params.tokenUsage); totalUsage = object(usage.total);
          const current = object(store.getSession(turn.sessionId).sessionMetadata?.nativeBackend);
          store.updateSessionMetadata(turn.sessionId, { nativeBackend: { ...current, totalUsage } });
          const last = object(usage.last);
          if (typeof last.inputTokens === 'number') turn.contextUsage({ inputTokens: last.inputTokens, contextWindowSize: usage.modelContextWindow });
          if (!usageBaseline) usageBaseline = Object.fromEntries(Object.entries(totalUsage).map(([key, value]) => [key, Math.max(0, Number(value) - Number(last[key] ?? 0))]));
          const delta = (key: string) => Math.max(0, Number(totalUsage![key] ?? 0) - Number(usageBaseline![key] ?? 0));
          turn.usage({ inputTokens: delta('inputTokens'), outputTokens: delta('outputTokens'), totalTokens: delta('totalTokens'),
            cachedInputTokens: delta('cachedInputTokens'), cacheWriteTokens: delta('cacheWriteInputTokens'), reasoningTokens: delta('reasoningOutputTokens') }); break;
        }
        case 'turn/plan/updated': turn.progress('Codex plan updated', { plan: params.plan }); break;
        case 'turn/diff/updated': turn.progress('Codex diff updated', { diff: params.diff }); break;
        case 'turn/completed': entry.nativeEnded = true; complete(object(params.turn)); break;
        default:
          if (!/account|auth|login/i.test(event.method)) turn.progress(event.method, { method: event.method });
      }
    });
    entry.rpc.onRequest((method, params) => this.request(entry, method, object(params)));
    const model = input.model && input.model !== 'default' ? input.model : undefined;
    const start = { cwd: turn.workDir, model, approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      config: { sandbox_workspace_write: { writable_roots: [turn.workDir], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } };
    const resumed = native.id === 'codex' && typeof native.sessionId === 'string';
    const response = object(await entry.rpc.request(resumed ? 'thread/resume' : 'thread/start', {
      ...start, ...(resumed ? { threadId: native.sessionId } : { ephemeral: false }),
    }));
    const sandbox = object(response.sandbox);
    if (response.approvalPolicy !== 'untrusted' || sandbox.type !== 'workspaceWrite' || sandbox.networkAccess === true) {
      throw new Error('Codex did not confirm the requested approval and sandbox policy.');
    }
    const thread = object(response.thread); entry.threadId = string(thread.id);
    if (!entry.threadId) throw new Error('Codex did not return a native thread identity.');
    if (entry.controller.signal.aborted) throw new Error('Codex execution interrupted before starting a turn.');
    turn.model(string(response.model) || model || string(connection.config.model));
    store.updateSessionMetadata(turn.sessionId, { nativeBackend: { id: 'codex', sessionId: entry.threadId, version: connection.version,
      ...(usageBaseline ? { totalUsage: usageBaseline } : {}), isolated: connection.isolated, model: response.model ?? connection.config.model, cwd: turn.workDir, approvalPolicy: 'untrusted', sandbox, instructionSources: response.instructionSources } });
    acceptingTurn = true;
    entry.startingTurn = entry.rpc.request('turn/start', { threadId: entry.threadId,
      input: await codexMediaInput(input, turn.message), model,
      ...(input.reasoningEffort && input.reasoningEffort !== 'max' ? { effort: input.reasoningEffort } : {}),
      approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [turn.workDir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    const started = object(await entry.startingTurn);
    entry.turnId = string(object(started.turn).id) || entry.turnId;
    const result = await Promise.race([completion, entry.rpc.closed.then(() => { throw entry.rpc!.failure ?? new Error('Codex exited before completing its turn.'); })]);
    if (entry.stopTask) await entry.stopTask;
    if (totalUsage) { const current = object(store.getSession(turn.sessionId).sessionMetadata?.nativeBackend); store.updateSessionMetadata(turn.sessionId, { nativeBackend: { ...current, totalUsage } }); }
    const status = string(result.status);
    const error = object(result.error);
    await turn.finish(status === 'completed' ? undefined : string(error.message) || `Codex turn ${status || 'failed'}.`, status === 'interrupted' || entry.controller.signal.aborted);
  }
  private item(turn: ExternalTurn, item: Json, completed: boolean): void {
    const id = string(item.id), type = string(item.type);
    if (!id || ['agentMessage', 'reasoning', 'userMessage'].includes(type)) return;
    const category = type === 'commandExecution' ? 'shell' : type === 'fileChange' ? 'write' : type === 'webSearch' ? 'read' : 'task';
    turn.tool(id, type, item, category);
    if (completed) turn.result(id, item.aggregatedOutput ?? item.changes ?? item, item.status === 'declined' ? 'denied' : item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0));
  }
  private async request(entry: Active, method: string, params: Json): Promise<unknown> {
    if (params.threadId !== entry.threadId || (entry.turnId && params.turnId !== entry.turnId)) throw new Error('Stale Codex request.');
    const turn = entry.turn;
    const itemId = string(params.itemId);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const command = method.includes('commandExecution');
      const tool = turn.tool(itemId, command ? 'commandExecution' : 'fileChange', params, command ? 'shell' : 'write');
      const reply = await turn.permission(tool, string(params.reason) || (command ? string(params.command) || 'Approve Codex command?' : 'Approve Codex file changes?'), params, array(params.availableDecisions).includes('acceptForSession'));
      const decisions = array(params.availableDecisions);
      return { decision: reply === 'reject' ? (decisions.includes('decline') ? 'decline' : 'cancel') : reply === 'always' && decisions.includes('acceptForSession') ? 'acceptForSession' : 'accept' };
    }
    if (method === 'item/permissions/requestApproval') {
      const tool = turn.tool(itemId, 'permissions', params, 'high_risk');
      const reply = await turn.permission(tool, string(params.reason) || 'Approve additional Codex permissions?', params);
      return { permissions: reply === 'reject' ? {} : object(params.permissions), scope: reply === 'always' ? 'session' : 'turn' };
    }
    if (method === 'item/tool/requestUserInput') {
      const nativeQuestions = array(params.questions).map(object);
      if (nativeQuestions.some(question => question.isSecret === true)) throw new Error('Enter secrets through native CLI authentication/settings, not chat forms.');
      const questions: HumanQuestion[] = nativeQuestions.map((question, index) => ({ id: `q${index}`, type: array(question.options).length ? 'single_select' : 'textarea',
        label: string(question.question), required: true, allowOther: question.isOther === true,
        ...(array(question.options).length ? { options: array(question.options).map(value => ({ value: string(object(value).label), label: string(object(value).label) })) } : {}),
      }));
      const reply = await turn.ask(itemId, questions);
      const answers: Record<string, { answers: string[] }> = {};
      if (reply.action === 'submit') for (let index = 0; index < nativeQuestions.length; index++) {
        const answer = reply.answers?.[`q${index}`]; answers[string(nativeQuestions[index].id)] = { answers: Array.isArray(answer) ? answer.map(String) : answer === undefined ? [] : [String(answer)] };
      }
      return { answers };
    }
    throw new Error(`Unsupported Codex request: ${method}`);
  }
  private stop(entry: Active): Promise<void> {
    if (entry.stopTask) return entry.stopTask;
    entry.stopTask = (async () => {
      entry.turn.cancelPending();
      if (!entry.rpc) return;
      if (entry.startingTurn && !entry.turnId) {
        const started = object(await withDeadline(entry.startingTurn, 5000, 'Codex turn startup could not be confirmed.'));
        entry.turnId = string(object(started.turn).id) || entry.turnId;
      }
      if (entry.threadId) {
        if (entry.turnId && !entry.nativeEnded) {
          await entry.rpc.request('turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId }, 5000);
          if (entry.completion) await withDeadline(entry.completion, 5000, 'Codex turn interruption could not be confirmed.');
        }
        // A turn interrupt does not kill unified-exec terminals that yielded a process handle.
        // Keep the protocol alive until the native owner confirms their explicit cleanup.
        await entry.rpc.request('thread/backgroundTerminals/clean', { threadId: entry.threadId }, 5000);
        entry.turn.progress('Codex native background terminal cleanup acknowledged', { threadId: entry.threadId });
      }
      await entry.rpc.stop();
    })();
    return entry.stopTask;
  }
  async interrupt(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId); if (!entry) return;
    entry.controller.abort(); await this.stop(entry); await entry.task;
  }
  close(sessionId: string): Promise<void> { return this.interrupt(sessionId); }
  hasPendingPermission(sessionId: string, id: string): boolean { return this.active.get(sessionId)?.turn.hasPermission(id) ?? false; }
  replyPermission(sessionId: string, id: string, reply: PermissionReply): boolean { return this.active.get(sessionId)?.turn.replyPermission(id, reply) ?? false; }
  hasPendingInteraction(sessionId: string, id: string): boolean { return this.active.get(sessionId)?.turn.hasInput(id) ?? false; }
  replyInteraction(sessionId: string, id: string): boolean { return this.active.get(sessionId)?.turn.replyInput(id) ?? false; }
  async models() {
    const directory = path.join(DATA_ROOT, 'native-codex-discovery'); fs.mkdirSync(directory, { recursive: true });
    const connection = await openCodex(directory);
    try {
      const response = object(await connection.rpc.request('model/list', { limit: 100 }));
      return { defaultModel: string(connection.config.model), models: array(response.data).map(value => {
        const model = object(value); return { id: string(model.model) || string(model.id), label: string(model.displayName) || string(model.model),
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.filter((v): v is import('../content-parts.js').InputModality => ['text','image','audio','video','file'].includes(String(v))) : undefined,
          efforts: array(model.supportedReasoningEfforts).map(value => string(object(value).reasoningEffort)) };
      }) };
    } finally { await connection.rpc.stop(); }
  }
}
export const codexBackend = new CodexBackend();
