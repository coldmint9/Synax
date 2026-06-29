import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk';
import type {
  AgentRun,
  AgentRunStep,
  AgentRunStreamChunk,
  RuntimeEvent,
  ToolCallRecord,
} from '../contracts.js';
import { agentEventService } from '../event-service.js';
import { makeRuntimeId, nowIso } from '../runtime-ids.js';
import { agentRuntimeStore } from '../session-store.js';
import {
  asStepUsageRecord,
  mergeStepUsage,
  type StepUsageRecord,
  usageFromAcpUpdate,
} from './acp-usage.js';

function extractText(content: { type: string; text?: string } | undefined): string {
  if (!content) return '';
  if (content.type === 'text') return content.text ?? '';
  return '';
}

function hashArgs(raw: unknown): string {
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return String(raw ?? '');
  }
}

export interface AcpUpdateMapperContext {
  sessionId: string;
  run: AgentRun;
  step: AgentRunStep;
  isReplay: boolean;
}

export class AcpUpdateMapper {
  private textBuffer = '';
  private thoughtBuffer = '';
  private partSequence = 0;
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private usageRecord: StepUsageRecord = {};

  constructor(private readonly ctx: AcpUpdateMapperContext) {}

  getAccumulatedUsage(): StepUsageRecord {
    return { ...this.usageRecord };
  }

  mapUpdate(update: SessionUpdate): AgentRunStreamChunk[] {
    if (this.ctx.isReplay) return [];

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const delta = extractText(update.content);
        if (!delta) return [];
        this.textBuffer += delta;
        const event = agentEventService.append({
          sessionId: this.ctx.sessionId,
          type: 'message_delta',
          summary: 'ACP message delta',
          payload: { runId: this.ctx.run.id, stepId: this.ctx.step.id, delta },
        });
        return [{
          type: 'message_delta',
          runId: this.ctx.run.id,
          stepId: this.ctx.step.id,
          delta,
          event,
        }];
      }
      case 'agent_thought_chunk': {
        const delta = extractText(update.content);
        if (!delta) return [];
        this.thoughtBuffer += delta;
        const event = agentEventService.append({
          sessionId: this.ctx.sessionId,
          type: 'thought_delta',
          summary: 'ACP thought delta',
          payload: { runId: this.ctx.run.id, stepId: this.ctx.step.id, delta },
        });
        return [{
          type: 'thought_delta',
          runId: this.ctx.run.id,
          stepId: this.ctx.step.id,
          delta,
          event,
        }];
      }
      case 'tool_call': {
        const toolCallId = update.toolCallId ?? makeRuntimeId('acp_tc');
        const record = agentRuntimeStore.appendToolCall({
          id: makeRuntimeId('tc'),
          sessionId: this.ctx.sessionId,
          runId: this.ctx.run.id,
          stepId: this.ctx.step.id,
          modelToolCallId: toolCallId,
          toolId: `acp.${update.kind ?? 'other'}`,
          category: mapKindToCategory(update.kind),
          mutability: update.kind === 'read' || update.kind === 'search' || update.kind === 'fetch' ? 'read' : 'write',
          argsHash: hashArgs(update.rawInput),
          inputSummary: update.title ?? update.kind ?? 'tool_call',
          inputRef: update.rawInput ?? null,
          outputSummary: null,
          outputRef: null,
          status: 'running',
          permissionDecisionId: null,
          startedAt: nowIso(),
          endedAt: null,
          error: null,
        });
        this.toolCalls.set(toolCallId, record);
        this.appendPart('tool_call', record.inputSummary, record.id, { acpToolCallId: toolCallId });
        const event = agentEventService.append({
          sessionId: this.ctx.sessionId,
          type: 'tool_call',
          summary: record.inputSummary,
          payload: { runId: this.ctx.run.id, stepId: this.ctx.step.id, toolCallId: record.id },
        });
        return [{
          type: 'tool_call',
          runId: this.ctx.run.id,
          stepId: this.ctx.step.id,
          toolCall: record,
          event,
        }];
      }
      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        const existing = this.toolCalls.get(toolCallId);
        const isComplete = update.status === 'completed' || update.status === 'failed';
        const record = existing
          ? agentRuntimeStore.updateToolCall(this.ctx.sessionId, existing.id, {
            status: update.status === 'failed' ? 'failed' : isComplete ? 'completed' : existing.status,
            outputSummary: update.title ?? existing.outputSummary,
            outputRef: update.rawOutput ?? existing.outputRef,
            endedAt: isComplete ? nowIso() : existing.endedAt,
            error: update.status === 'failed' ? 'ACP tool call failed' : existing.error,
          })
          : agentRuntimeStore.appendToolCall({
            id: makeRuntimeId('tc'),
            sessionId: this.ctx.sessionId,
            runId: this.ctx.run.id,
            stepId: this.ctx.step.id,
            modelToolCallId: toolCallId,
            toolId: `acp.${update.kind ?? 'other'}`,
            category: mapKindToCategory(update.kind),
            mutability: 'write',
            argsHash: hashArgs(update.rawInput),
            inputSummary: update.title ?? 'tool_call_update',
            inputRef: update.rawInput ?? null,
            outputSummary: update.title ?? null,
            outputRef: update.rawOutput ?? null,
            status: update.status === 'failed' ? 'failed' : isComplete ? 'completed' : 'running',
            permissionDecisionId: null,
            startedAt: nowIso(),
            endedAt: isComplete ? nowIso() : null,
            error: update.status === 'failed' ? 'ACP tool call failed' : null,
          });
        this.toolCalls.set(toolCallId, record);
        if (!isComplete) return [];
        this.appendPart('tool_result', record.outputSummary ?? record.inputSummary, record.id, {
          acpToolCallId: toolCallId,
        });
        const event = agentEventService.append({
          sessionId: this.ctx.sessionId,
          type: 'tool_result',
          summary: record.outputSummary ?? record.inputSummary,
          payload: { runId: this.ctx.run.id, stepId: this.ctx.step.id, toolCallId: record.id },
        });
        return [{
          type: 'tool_result',
          runId: this.ctx.run.id,
          stepId: this.ctx.step.id,
          toolCall: record,
          event,
        }];
      }
      case 'plan': {
        const planText = update.entries.map((entry) => `[${entry.status ?? '-'}] ${entry.content}`).join('\n');
        const event = agentEventService.append({
          sessionId: this.ctx.sessionId,
          type: 'progress_updated',
          summary: 'ACP plan update',
          payload: { plan: planText },
        });
        return [{ type: 'event', event }];
      }
      case 'usage_update': {
        if (this.ctx.isReplay) return [];
        this.persistUsage(usageFromAcpUpdate(update));
        return [];
      }
      default:
        return [];
    }
  }

  finalizeAssistantMessage(): import('../contracts.js').AgentRuntimeMessage | null {
    const content = this.textBuffer.trim();
    if (!content) return null;
    this.appendPart('text', content, null, {});
    const usage = Object.keys(this.usageRecord).length > 0 ? this.usageRecord : undefined;
    return agentRuntimeStore.appendMessage({
      id: makeRuntimeId('msg'),
      sessionId: this.ctx.sessionId,
      runId: this.ctx.run.id,
      stepId: this.ctx.step.id,
      role: 'assistant',
      content,
      metadata: {
        source: 'acp',
        thought: this.thoughtBuffer.trim() || undefined,
        ...(usage ? { usage } : {}),
      },
      createdAt: nowIso(),
    });
  }

  private persistUsage(patch: StepUsageRecord): void {
    this.usageRecord = mergeStepUsage(this.usageRecord, patch);
    const step = agentRuntimeStore.getRunStep(this.ctx.step.id);
    const existing = asStepUsageRecord(step.metadata.usage);
    agentRuntimeStore.updateRunStep(this.ctx.step.id, {
      metadata: {
        ...step.metadata,
        usage: mergeStepUsage(existing, this.usageRecord),
      },
    });
  }

  private appendPart(
    kind: import('../contracts.js').AgentRunPartKind,
    content: string,
    toolCallId: string | null,
    metadata: Record<string, unknown>,
  ): void {
    this.partSequence += 1;
    agentRuntimeStore.appendRunPart({
      id: makeRuntimeId('part'),
      runId: this.ctx.run.id,
      stepId: this.ctx.step.id,
      sessionId: this.ctx.sessionId,
      kind,
      sequence: this.partSequence,
      content,
      toolCallId,
      metadata,
      createdAt: nowIso(),
    });
  }
}

function mapKindToCategory(kind: ToolKind | null | undefined): import('../contracts.js').CapabilityCategory {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return 'read';
    case 'execute':
      return 'shell';
    case 'edit':
    case 'move':
    case 'delete':
      return 'write';
    default:
      return 'high_risk';
  }
}

export function createRunStartedChunk(
  sessionId: string,
  run: AgentRun,
  triggerMessageId: string | null,
): AgentRunStreamChunk {
  const event = agentEventService.append({
    sessionId,
    type: 'run_started',
    summary: 'ACP run started',
    payload: { runId: run.id, triggerMessageId, model: run.model },
  });
  return { type: 'run_started', run, event };
}

export function createStepStartedChunk(
  sessionId: string,
  step: AgentRunStep,
): AgentRunStreamChunk {
  const event = agentEventService.append({
    sessionId,
    type: 'step_started',
    summary: 'ACP step started',
    payload: { runId: step.runId, stepId: step.id },
  });
  return { type: 'step_started', step, event };
}

export function createRunCompletedChunk(
  sessionId: string,
  run: AgentRun,
  message?: import('../contracts.js').AgentRuntimeMessage | null,
): AgentRunStreamChunk {
  const event = agentEventService.append({
    sessionId,
    type: 'run_completed',
    summary: 'ACP run completed',
    payload: { runId: run.id, stopReason: run.stopReason },
  });
  return {
    type: 'run_completed',
    run,
    message: message ?? undefined,
    event,
  };
}

export function createRunFailedChunk(
  sessionId: string,
  run: AgentRun,
  error: string,
): AgentRunStreamChunk {
  const event = agentEventService.append({
    sessionId,
    type: 'run_failed',
    summary: error,
    payload: { runId: run.id, error },
  });
  return { type: 'run_failed', run, error, event };
}

export function createPermissionRequestedChunk(
  runId: string,
  stepId: string,
  permission: import('../contracts.js').PermissionDecision,
  toolCall: ToolCallRecord,
): AgentRunStreamChunk {
  const event = agentEventService.append({
    sessionId: permission.sessionId,
    type: 'permission_requested',
    summary: permission.reason,
    payload: { permissionId: permission.id, toolCallId: toolCall.id },
  });
  return {
    type: 'permission_requested',
    runId,
    stepId,
    permission,
    toolCall,
    event,
  };
}
