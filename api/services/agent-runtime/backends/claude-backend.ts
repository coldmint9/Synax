import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CanUseTool, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DATA_ROOT } from '../../../lib/env.js';
import { AsyncQueue } from '../../acp/protocol/async-queue.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { ExternalTurn } from './external-turn.js';
import { claudeOptions, CLAUDE_SDK_VERSION } from './claude-connection.js';
import { withDeadline, type ManagedProcess } from '../managed-process.js';
import type { BackendAdapter } from './backend-contracts.js';
import type { AgentRunStreamChunk, PermissionReply, StreamTurnRequest, CapabilityCategory } from '../contracts.js';
import type { HumanQuestion } from '../control-contracts.js';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const category = (name: string): CapabilityCategory => name === 'Bash' ? 'shell' : /^(Read|Glob|Grep|WebSearch|WebFetch)$/.test(name) ? 'read' : /^(Edit|Write|NotebookEdit)$/.test(name) ? 'write' : 'task';
interface Active {
  turn: ExternalTurn; query?: Query; process?: ManagedProcess; controller: AbortController; task: Promise<void>;
  inputs: AsyncQueue<SDKUserMessage>; initialized: boolean;
}
export class ClaudeBackend implements BackendAdapter {
  private readonly active = new Map<string, Active>();
  async *stream(sessionId: string, _mode: string, input: StreamTurnRequest, signal?: AbortSignal): AsyncGenerator<AgentRunStreamChunk> {
    if (this.active.has(sessionId)) throw new Error('Claude session is already active.');
    if (input.maxSteps || input.maxTokens || input.temperature !== undefined) throw new Error('Claude controls its own agent loop; Native Synax limits and temperature overrides are unsupported.');
    const turn = new ExternalTurn(sessionId, 'claude-code', input);
    const entry: Active = { turn, controller: new AbortController(), task: Promise.resolve(), inputs: new AsyncQueue(), initialized: false };
    this.active.set(sessionId, entry);
    const abort = () => { entry.controller.abort(); void this.stop(entry).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    entry.task = this.run(entry, input).catch(error => turn.finish(error instanceof Error ? error.message : String(error), entry.controller.signal.aborted))
      .finally(async () => {
        try { entry.inputs.close(); entry.query?.close(); await entry.process?.stop(); }
        catch (error) { turn.cleanupUnconfirmed(error); throw error; }
        finally { turn.queue.close(); }
      });
    void entry.task.catch(() => {}); // The generator rethrows after draining terminal events.
    try { yield* turn.queue; }
    finally {
      try { await entry.task; }
      finally { signal?.removeEventListener('abort', abort); this.active.delete(sessionId); }
    }
  }
  private async run(entry: Active, input: StreamTurnRequest): Promise<void> {
    const { turn } = entry; await turn.captureBaseline();
    const session = store.getSession(turn.sessionId); const native = object(session.sessionMetadata?.nativeBackend);
    const { options, context } = claudeOptions(turn.workDir, process => { entry.process = process; });
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    if (entry.controller.signal.aborted) throw new Error('Claude execution interrupted.');
    const model = input.model && input.model !== 'default' ? input.model : context.model;
    const reportedUsage = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }>();
    const streamed = new Set<string>(); let currentMessage = ''; let contextModel = ''; let hadText = false; let completed = false;
    entry.inputs.push({ type: 'user', message: { role: 'user', content: turn.message }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() });
    entry.query = query({ prompt: entry.inputs, options: { ...options, model,
      ...(native.id === 'claude-code' && typeof native.sessionId === 'string' ? { resume: native.sessionId } : {}),
      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      canUseTool: (name, args, request) => this.permission(entry, name, args, request),
    } });
    try {
      for await (const message of entry.query) {
        if (entry.controller.signal.aborted) throw new Error('Claude execution interrupted.');
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.permissionMode !== 'default' || message.mcp_servers.length || message.plugins.length || message.skills.length) throw new Error(`Claude did not confirm isolated configuration: ${JSON.stringify({ permissionMode: message.permissionMode, mcp: message.mcp_servers.map(server => server.name), plugins: message.plugins.map(plugin => plugin.name), skills: message.skills })}`);
          if (native.id === 'claude-code' && native.sessionId && native.sessionId !== message.session_id) throw new Error('Claude could not resume the original native session.');
          entry.initialized = true; turn.model(message.model);
          store.updateSessionMetadata(turn.sessionId, { nativeBackend: { id: 'claude-code', sessionId: message.session_id, version: message.claude_code_version,
            sdkVersion: CLAUDE_SDK_VERSION, model: message.model, cwd: message.cwd, isolated: true, auth: context.auth,
            settingsSources: [], instructionSources: [], sandbox: options.sandbox, disabledTools: options.disallowedTools, tools: message.tools, permissions: message.permissionMode } });
          continue;
        }
        if (!entry.initialized) continue;
        if (message.type === 'stream_event') {
          if (message.parent_tool_use_id) { turn.progress('Claude subagent stream', { parentToolUseId: message.parent_tool_use_id, eventType: message.event.type }); continue; }
          const event = message.event;
          if (event.type === 'message_start') currentMessage = event.message.id;
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') { turn.delta(event.delta.text); hadText = true; streamed.add(`${currentMessage}:text`); }
            if (event.delta.type === 'thinking_delta') { turn.delta(event.delta.thinking, true); streamed.add(`${currentMessage}:thinking`); }
          }
        } else if (message.type === 'assistant') {
          if (message.message.usage && message.message.id) {
            const usage = message.message.usage;
            if (!message.parent_tool_use_id) {
              contextModel = message.message.model;
              turn.contextUsage({ inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), requestId: message.message.id });
            }
            reportedUsage.set(message.message.id, { inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0 });
            const total = [...reportedUsage.values()].reduce((sum, current) => ({ inputTokens: sum.inputTokens + current.inputTokens, outputTokens: sum.outputTokens + current.outputTokens, cachedInputTokens: sum.cachedInputTokens + current.cachedInputTokens, cacheWriteTokens: sum.cacheWriteTokens + current.cacheWriteTokens }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
            turn.usage({ ...total, totalTokens: total.inputTokens + total.outputTokens, partial: true });
          }
          for (const block of message.message.content) {
            if (block.type === 'tool_use') turn.tool(block.id, block.name, { ...object(block.input), parentToolUseId: message.parent_tool_use_id }, category(block.name));
            else if (!message.parent_tool_use_id && block.type === 'text' && !streamed.has(`${message.message.id}:text`)) { turn.delta(block.text); hadText = true; }
            else if (!message.parent_tool_use_id && block.type === 'thinking' && !streamed.has(`${message.message.id}:thinking`)) turn.delta(block.thinking, true);
          }
          if (message.error) turn.progress('Claude response error', { code: message.error });
        } else if (message.type === 'user') {
          for (const block of list(message.message.content).map(object)) if (block.type === 'tool_result') turn.result(text(block.tool_use_id), message.tool_use_result ?? block.content, block.is_error === true);
        } else if (message.type === 'result') {
          const contextWindow = message.modelUsage?.[contextModel]?.contextWindow;
          if (contextWindow) turn.contextUsage({ contextWindowSize: contextWindow });
          for (const denial of message.permission_denials) turn.result(denial.tool_use_id, 'Native permission denied.', 'denied');
          const usage = message.usage; const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          turn.usage({ inputTokens, outputTokens: usage.output_tokens, totalTokens: inputTokens + usage.output_tokens,
            cachedInputTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0, costUsd: message.total_cost_usd });
          if (message.subtype === 'success' && !hadText) turn.delta(message.result);
          const error = message.is_error || message.subtype !== 'success' ? ('errors' in message ? message.errors.join('\n') : 'Claude reported an unsuccessful result.') : undefined;
          await turn.finish(error ? context.redact(error) : undefined); completed = true; break;
        } else this.progress(turn, message);
      }
      if (!completed) throw new Error(entry.controller.signal.aborted ? 'Claude execution interrupted.' : 'Claude exited before completing its turn.');
    } catch (error) { throw new Error(context.redact(error)); }
  }
  private async permission(entry: Active, name: string, input: Record<string, unknown>, request: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const { turn } = entry;
    if (!entry.initialized || entry.controller.signal.aborted || request.signal.aborted) return { behavior: 'deny', message: 'The native turn is not available.' };
    const abort = () => turn.cancelPending(); request.signal.addEventListener('abort', abort, { once: true });
    try {
      if (name === 'AskUserQuestion') {
        const nativeQuestions = list(input.questions).map(object);
        const questions: HumanQuestion[] = nativeQuestions.map((question, index) => ({ id: `q${index}`, type: question.multiSelect === true ? 'multi_select' : 'single_select',
          label: text(question.question), required: true, allowOther: true,
          options: list(question.options).map(option => ({ value: text(object(option).label), label: text(object(option).label), description: text(object(option).description) })),
        }));
        const answer = await turn.ask(request.toolUseID, questions);
        if (answer.action !== 'submit') return { behavior: 'deny', message: 'The user cancelled the question.' };
        const answers = Object.fromEntries(nativeQuestions.map((question, index) => {
          const value = answer.answers?.[`q${index}`]; return [text(question.question), Array.isArray(value) ? value.join(', ') : String(value ?? '')];
        }));
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const tool = turn.tool(request.toolUseID, name, input, category(name));
      const reason = [request.title || request.decisionReason || `Approve Claude ${name}?`, request.description, request.blockedPath].filter(Boolean).join(' · ');
      const reply = await turn.permission(tool, reason, { tool: name, input, blockedPath: request.blockedPath, decisionReason: request.decisionReason });
      if (reply === 'reject' || entry.controller.signal.aborted || request.signal.aborted) return { behavior: 'deny', message: 'The user denied this operation.' };
      return { behavior: 'allow', updatedInput: input };
    } finally { request.signal.removeEventListener('abort', abort); }
  }
  private progress(turn: ExternalTurn, message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'api_retry') turn.progress('Claude API retry', { attempt: message.attempt, maxRetries: message.max_retries, retryDelayMs: message.retry_delay_ms, status: message.error_status, error: message.error });
    else if (message.type === 'tool_progress') turn.progress('Claude tool progress', { toolUseId: message.tool_use_id, parentToolUseId: message.parent_tool_use_id, elapsedSeconds: message.elapsed_time_seconds });
    else if (message.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'status', 'compact_boundary'].includes(message.subtype)) {
      const data = object(message); turn.progress(`Claude ${message.subtype}`, { taskId: data.task_id, toolUseId: data.tool_use_id, status: data.status, summary: data.summary });
    }
  }
  private async stop(entry: Active): Promise<void> {
    entry.turn.cancelPending();
    if (entry.query) await withDeadline(entry.query.interrupt(), 1000, 'Claude interrupt timed out.').catch(() => {});
    entry.inputs.close(); entry.query?.close(); if (entry.process) await entry.process.stop();
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
    const directory = path.join(DATA_ROOT, 'native-claude-discovery'); fs.mkdirSync(directory, { recursive: true });
    let process: ManagedProcess | undefined;
    const { options, context } = claudeOptions(directory, child => { process = child; });
    const { query } = await import('@anthropic-ai/claude-agent-sdk'); const inputs = new AsyncQueue<SDKUserMessage>();
    const connection = query({ prompt: inputs, options });
    try { const models = await withDeadline(connection.supportedModels(), 15_000, 'Claude model discovery timed out.');
      return { defaultModel: context.model, models: models.map(model => ({ id: model.value, label: model.displayName, efforts: model.supportedEffortLevels })) };
    } catch (error) { throw new Error(context.redact(error)); }
    finally { inputs.close(); connection.close(); await process?.stop(); }
  }
}
export const claudeBackend = new ClaudeBackend();
