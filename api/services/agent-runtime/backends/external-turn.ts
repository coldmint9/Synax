import { hasInlineMedia, normalizeMediaPayload, redactInlineMedia } from '../media-tool-content.js';
import type { RuntimeContentPart } from '../content-parts.js';
import { normalizeInput, hasInput } from '../content-parts.js';
import { AsyncQueue } from '../../acp/protocol/async-queue.js';
import { captureFileChangeBaseline, captureFileChanges, type FileChangeBaseline } from '../../acp/file-change-capture.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { agentEventService as events } from '../event-service.js';
import { activateAcceptedRun } from '../run-admission.js';
import { makeRuntimeId, nowIso } from '../runtime-ids.js';
import { interactionService } from '../interaction-service.js';
import { validateBackendTurnInput } from './backend-binding.js';
import { bindSessionWorkDir } from '../tools/workspace.js';
import type { AgentRun, AgentRunStep, AgentRunStreamChunk, PermissionReply, StreamTurnRequest, ToolCallRecord, CapabilityCategory } from '../contracts.js';
import type { InteractionReply, HumanQuestion } from '../control-contracts.js';

export class ExternalTurn {
  readonly queue = new AsyncQueue<AgentRunStreamChunk>();
  readonly run: AgentRun;
  readonly step: AgentRunStep;
  readonly workDir: string;
  readonly message: string;
  private readonly tools = new Map<string, ToolCallRecord>();
  private readonly permissions = new Map<string, (reply: PermissionReply) => void>();
  private readonly inputs = new Map<string, (reply: InteractionReply) => void>();
  private text = '';
  private thought = '';
  private ended = false;
  private finishing = false;
  private readonly mediaTasks: Promise<void>[] = [];
  private mediaError: string | undefined;
  private baseline: FileChangeBaseline | null = null;
  constructor(readonly sessionId: string, readonly backendId: string, readonly input: StreamTurnRequest) {
    input = normalizeInput(input);
    validateBackendTurnInput(backendId, input);
    this.workDir = bindSessionWorkDir(sessionId);
    const session = store.getSession(sessionId);
    const native = session.sessionMetadata?.nativeBackend as { id?: string; sessionId?: string } | undefined;
    const continuesNative = native?.id === backendId && typeof native.sessionId === 'string';
    this.message = hasInput(input) ? input.message?.trim() ?? '' : (continuesNative
      ? 'Continue the existing task from the current native session state. Check unfinished work and prior tool outcomes first. Do not replay completed actions.'
      : session.prompt);
    const user = store.appendMessage({ id: makeRuntimeId('msg'), sessionId, runId: input.acceptedRunId ?? null, stepId: null,
      role: 'user', content: this.message, contentParts: input.contentParts, metadata: { source: input.messageSource ?? (continuesNative && !hasInput(input) ? `${backendId}_continue` : `${backendId}_turn`) }, createdAt: nowIso() });
    this.run = input.acceptedRunId ? activateAcceptedRun(sessionId, input.acceptedRunId, user.id, input.model ?? null)
      : store.appendRun({ id: makeRuntimeId('run'), sessionId, status: 'running', startedAt: nowIso(), completedAt: null,
        triggerMessageId: user.id, currentStep: 1, stopReason: null, model: input.model ?? null, metadata: { backendId } });
    this.run = store.updateRun(this.run.id, { metadata: { ...this.run.metadata, reasoningEffort: input.reasoningEffort ?? null } });
    this.step = store.appendRunStep({ id: makeRuntimeId('step'), sessionId, runId: this.run.id, index: 1, status: 'running',
      model: input.model ?? null, startedAt: nowIso(), completedAt: null, finishReason: null, metadata: { backendId, externalTurn: true, reasoningEffort: input.reasoningEffort ?? null } });
    store.updateSession(sessionId, { status: 'running', activeRunId: this.run.id, pendingResumeToken: null, blockedReason: null, updatedAt: nowIso() });
    this.emit({ type: 'message', message: user }); this.emit({ type: 'run_started', run: this.run }); this.emit({ type: 'step_started', step: this.step });
  }
  async captureBaseline(): Promise<void> { this.baseline = await captureFileChangeBaseline(this.workDir); }
  emit(chunk: AgentRunStreamChunk): void { if (!this.ended) this.queue.push(chunk); }
  delta(value: string, thought = false): void {
    if (this.ended || this.finishing || !value) return;
    if (thought) this.thought += value; else this.text += value;
    this.emit({ type: thought ? 'thought_delta' : 'message_delta', runId: this.run.id, stepId: this.step.id, delta: value });
  }
  model(value?: string): void {
    if (!value) return;
    store.updateRun(this.run.id, { model: value }); store.updateRunStep(this.step.id, { model: value });
  }
  usage(usage: Record<string, unknown>): void {
    const step = store.getRunStep(this.step.id);
    store.updateRunStep(step.id, { metadata: { ...step.metadata, usage } });
  }
  contextUsage(usage: Record<string, unknown>): void {
    const step = store.getRunStep(this.step.id);
    const previous = step.metadata.contextUsage as Record<string, unknown> | undefined;
    store.updateRunStep(step.id, { metadata: { ...step.metadata, contextUsage: { ...previous, ...usage, source: this.backendId, measuredAt: nowIso() } } });
  }
  tool(id: string, name: string, input: unknown, category: CapabilityCategory = 'task'): ToolCallRecord {
    input = redactInlineMedia(input);
    const previous = this.tools.get(id);
    if (previous) return previous;
    if (this.finishing || this.ended) throw new Error('The external turn has ended.');
    const record = store.appendToolCall({ id: makeRuntimeId('tc'), sessionId: this.sessionId, runId: this.run.id, stepId: this.step.id,
      modelToolCallId: id, toolId: `${this.backendId}.${name}`, category, mutability: category === 'read' ? 'read' : 'write',
      argsHash: store.hashArgs(input), inputSummary: typeof input === 'object' && input && 'command' in input ? String((input as { command: unknown }).command) : name, inputRef: input, outputSummary: null, outputRef: null,
      status: 'running', permissionDecisionId: null, startedAt: nowIso(), endedAt: null, error: null });
    this.tools.set(id, record); this.emit({ type: 'tool_call', runId: this.run.id, stepId: this.step.id, toolCall: record });
    return record;
  }
  result(id: string, output: unknown, failed: boolean | 'denied' = false): void {
    const tool = this.tools.get(id); if (!tool || this.ended || this.finishing) return;
    if (hasInlineMedia(output)) {
      const task=normalizeMediaPayload(store.getSession(this.sessionId).projectId,output)
        .then(normalized=>this.applyResult(id,normalized.value,failed,normalized.contentParts))
        .catch(error=>{this.mediaError=error instanceof Error?error.message:String(error);this.applyResult(id,{error:this.mediaError},true)});
      this.mediaTasks.push(task);return;
    }
    this.applyResult(id,output,failed);
  }
  private applyResult(id:string, output:unknown, failed:boolean|'denied', contentParts?:RuntimeContentPart[]):void {
    const tool=this.tools.get(id);if(!tool||this.ended)return;
    const summary = typeof output === 'string' ? output : JSON.stringify(output ?? {});
    const updated = store.updateToolCall(this.sessionId, tool.id, { status: failed === 'denied' ? 'denied' : failed ? 'failed' : 'completed', outputRef: output, contentParts,
      outputSummary: summary.slice(0, 2000), error: failed ? summary.slice(0, 2000) : null, endedAt: nowIso() });
    this.tools.set(id, updated); this.emit({ type: 'tool_result', runId: this.run.id, stepId: this.step.id, toolCall: updated });
  }
  progress(summary: string, payload: Record<string, unknown> = {}): void {
    this.emit({ type: 'event', event: events.append({ sessionId: this.sessionId, type: 'progress_updated', summary,
      payload: { backendId: this.backendId, runId: this.run.id, ...payload }, visibility: 'internal' }) });
  }
  async permission(tool: ToolCallRecord, reason: string, approvalRequest?: unknown, allowAlways = false): Promise<PermissionReply> {
    if (this.finishing || this.ended) return 'reject';
    if (approvalRequest !== undefined) tool = store.updateToolCall(this.sessionId, tool.id, { inputRef: { nativeTool: tool.inputRef, approvalRequest } });
    const decision = store.appendPermission({ id: makeRuntimeId('pd'), sessionId: this.sessionId, runId: this.run.id,
      stepId: this.step.id, toolCallId: tool.id, coarseCategory: tool.category === 'read' ? 'read' : tool.category === 'write' ? 'write' : 'high_risk',
      internalGate: tool.category === 'shell' ? 'shell' : tool.category === 'write' ? 'write' : 'none', action: 'ask', reason,
      patterns: [tool.inputSummary], userReply: null, createdAt: nowIso(), resolvedAt: null, resumeToken: makeRuntimeId('native_perm'),
      metadata: { source: this.backendId, nativeToolCallId: tool.modelToolCallId, allowedReplies: allowAlways ? ['once', 'always', 'reject'] : ['once', 'reject'] } });
    store.updateToolCall(this.sessionId, tool.id, { permissionDecisionId: decision.id });
    this.waiting('waiting_permission', decision.resumeToken, reason);
    this.emit({ type: 'permission_requested', runId: this.run.id, stepId: this.step.id, permission: decision, toolCall: tool });
    return new Promise(resolve => this.permissions.set(decision.id, resolve));
  }
  hasPermission(id: string): boolean { return this.permissions.has(id); }
  replyPermission(id: string, reply: PermissionReply): boolean {
    const resolve = this.permissions.get(id); if (!resolve) return false;
    this.permissions.delete(id); this.resumeIfReady(); resolve(reply); return true;
  }
  async ask(nativeId: string, questions: HumanQuestion[], title = 'Agent needs your input'): Promise<InteractionReply> {
    const tool = this.tool(nativeId, 'request_input', { questions });
    const interaction = interactionService.request({ sessionId: this.sessionId, runId: this.run.id, stepId: this.step.id,
      toolCallId: tool.id, kind: 'clarification', request: { title, questions } });
    this.progress(title, { interactionId: interaction.id });
    return new Promise(resolve => this.inputs.set(interaction.id, resolve));
  }
  hasInput(id: string): boolean { return this.inputs.has(id); }
  replyInput(id: string): boolean {
    const resolve = this.inputs.get(id); if (!resolve) return false;
    const ready = interactionService.ready(this.sessionId); if (ready?.id !== id) return false;
    const consumed = interactionService.consume(this.sessionId); if (!consumed?.response) return false;
    this.inputs.delete(id);
    if (consumed.toolCallId) {
      const tool = store.getToolCall(this.sessionId, consumed.toolCallId);
      this.result(tool.modelToolCallId!, consumed.response, consumed.response.action === 'cancel' ? 'denied' : false);
    }
    store.updateRunStep(this.step.id, { status: 'running', completedAt: null, finishReason: null });
    this.resumeIfReady(); resolve(consumed.response); return true;
  }
  private waiting(status: 'waiting_permission' | 'waiting_input', token: string | null, reason: string): void {
    store.updateRun(this.run.id, { status }); store.updateRunStep(this.step.id, { status });
    store.updateSession(this.sessionId, { status, pendingResumeToken: token, blockedReason: reason, updatedAt: nowIso() });
  }
  private resumeIfReady(): void {
    if (this.permissions.size || this.inputs.size || this.ended) return;
    store.updateRun(this.run.id, { status: 'running' }); store.updateRunStep(this.step.id, { status: 'running' });
    store.updateSession(this.sessionId, { status: 'running', pendingResumeToken: null, blockedReason: null, updatedAt: nowIso() });
  }
  cancelPending(): void {
    for (const [id, resolve] of this.permissions) {
      const decision = store.listPermissions(this.sessionId).find(item => item.id === id);
      if (decision && !decision.resolvedAt) store.updatePermission(this.sessionId, id, { action: 'deny', userReply: 'reject', resolvedAt: nowIso() });
      resolve('reject');
    }
    this.permissions.clear();
    if (this.inputs.size) interactionService.cancel(this.sessionId);
    for (const resolve of this.inputs.values()) resolve({ revision: 1, action: 'cancel' });
    this.inputs.clear();
  }
  cleanupUnconfirmed(error: unknown): void {
    store.updateSessionMetadata(this.sessionId, { runtimeControl: { state: 'unconfirmed', runId: this.run.id,
      reason: error instanceof Error ? error.message : 'Native process termination could not be confirmed.' } });
  }
  async finish(error?: string, interrupted = false): Promise<void> {
    if (this.ended || this.finishing) return;
    this.finishing = true;
    await Promise.all(this.mediaTasks);
    error ??= this.mediaError;
    this.cancelPending();
    for (const tool of this.tools.values()) {
      const current = store.getToolCall(this.sessionId, tool.id);
      if (current.status === 'running' || current.status === 'pending') {
        const closed = store.updateToolCall(this.sessionId, tool.id, { status: interrupted ? 'cancelled' : 'failed', endedAt: nowIso(), error: error ?? 'No terminal tool result was reported.' });
        this.emit({ type: 'tool_result', runId: this.run.id, stepId: this.step.id, toolCall: closed });
      }
    }
    const changes = await captureFileChanges(this.workDir, [], this.baseline);
    const message = this.text || this.thought ? store.appendMessage({ id: makeRuntimeId('msg'), sessionId: this.sessionId, runId: this.run.id,
      stepId: this.step.id, role: 'assistant', content: this.text, createdAt: nowIso(), metadata: {
        source: this.backendId, thought: this.thought || undefined, partial: Boolean(error || interrupted), runId: this.run.id, stepId: this.step.id,
      } }) : undefined;
    const status = interrupted ? 'interrupted' : error ? 'failed' : 'completed';
    const run = store.getRun(this.run.id);
    const finished = store.updateRun(run.id, { status, completedAt: nowIso(), stopReason: error ?? 'end_turn', metadata: {
      ...run.metadata, backendId: this.backendId, fileChanges: changes.fileChanges, changeSummary: changes.changeSummary,
    } });
    store.updateRunStep(this.step.id, { status, completedAt: nowIso(), finishReason: error ?? 'end_turn' });
    store.updateSession(this.sessionId, { status, activeRunId: null, pendingResumeToken: null, blockedReason: error ?? null,
      resultSummary: this.text || error || null, completedAt: nowIso(), updatedAt: nowIso() });
    this.emit(error ? { type: 'run_failed', run: finished, error } : { type: 'run_completed', run: finished, message });
    this.emit({ type: 'done', sessionId: this.sessionId, runId: finished.id });
    this.ended = true; this.queue.close();
  }
}
