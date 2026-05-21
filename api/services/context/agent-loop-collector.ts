import type { AgentRunFileChange, CoordinatesRunEvent } from '../acp/contracts.js';
import type { NewAgentLoopRecord, NewAgentLoopStep } from '../contracts/context.js';

interface AgentLoopCollectorInput {
  projectId: string;
  nodeId?: string | null;
  runId: string;
  provider: string;
  userId?: string | null;
  rawInput: string;
  contextSnapshotId?: string | null;
  startedAt?: string;
}

function isoFromTs(ts?: number, fallback?: string): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  return fallback ?? new Date().toISOString();
}

export class AgentLoopCollector {
  private readonly input: AgentLoopCollectorInput;
  private readonly steps: NewAgentLoopStep[] = [];
  private readonly startedAt: string;
  private fileChanges: AgentRunFileChange[] = [];
  private status: NewAgentLoopRecord['status'] = 'running';
  private finalOutput: string | null = null;
  private summary: string | null = null;
  private completedAt: string | null = null;
  private lastMessageStep: NewAgentLoopStep | null = null;
  private lastThoughtStep: NewAgentLoopStep | null = null;
  private toolSteps = new Map<string, number>();

  constructor(input: AgentLoopCollectorInput) {
    this.input = input;
    this.startedAt = input.startedAt ?? new Date().toISOString();
    this.pushStep({
      kind: 'user_input',
      title: 'User request',
      content: input.rawInput,
      metadata: {},
      createdAt: this.startedAt,
    });
    if (input.contextSnapshotId) {
      this.pushStep({
        kind: 'context_snapshot',
        title: 'Run context snapshot',
        content: `Context snapshot ${input.contextSnapshotId}`,
        metadata: { contextSnapshotId: input.contextSnapshotId },
        createdAt: this.startedAt,
      });
    }
  }

  absorb(event: CoordinatesRunEvent): void {
    const createdAt = isoFromTs(event.ts, this.startedAt);
    const message = typeof event.payload?.message === 'string' ? event.payload.message : '';
    const reason = typeof event.payload?.reason === 'string' ? event.payload.reason : '';

    switch (event.type) {
      case 'agent_message': {
        const isThought = message.startsWith('[thought] ');
        const content = isThought ? message.replace(/^\[thought\]\s*/, '') : message;
        if (!content.trim()) return;
        if (isThought) {
          this.appendOrMergeThought(content, createdAt);
        } else {
          this.appendOrMergeMessage(content, createdAt);
        }
        return;
      }
      case 'intent_interpreted': {
        if (message.trim()) {
          this.pushStep({
            kind: 'agent_thought',
            title: 'Execution plan',
            content: message,
            payload: event.payload ?? {},
            metadata: { sourceEventType: event.type, visible: true },
            createdAt,
          });
        }
        return;
      }
      case 'artifact_proposed': {
        this.lastMessageStep = null;
        this.lastThoughtStep = null;
        const toolId = this.extractToolId(event);
        const index = this.pushStep({
          kind: 'tool_call',
          title: toolId ? `Tool call ${toolId}` : 'Tool call',
          content: message || 'Tool call started',
          payload: event.payload ?? {},
          metadata: { sourceEventType: event.type, toolCallId: toolId },
          createdAt,
        });
        if (toolId) this.toolSteps.set(toolId, index);
        return;
      }
      case 'artifact_applied': {
        this.lastMessageStep = null;
        this.lastThoughtStep = null;
        const toolId = this.extractToolId(event);
        this.pushStep({
          kind: 'tool_result',
          title: toolId ? `Tool result ${toolId}` : 'Tool result',
          content: message || 'Tool call completed',
          payload: event.payload ?? {},
          metadata: { sourceEventType: event.type, toolCallId: toolId },
          createdAt,
        });
        return;
      }
      case 'run_completed': {
        this.status = 'completed';
        this.completedAt = createdAt;
        this.fileChanges = Array.isArray(event.payload?.fileChanges)
          ? (event.payload.fileChanges as AgentRunFileChange[])
          : this.fileChanges;
        this.finalOutput = message || this.finalOutput;
        this.summary = this.summary ?? (message || 'Run completed.');
        this.pushStep({
          kind: 'final_output',
          title: 'Final output',
          content: message || 'Run completed.',
          payload: event.payload ?? {},
          metadata: { sourceEventType: event.type },
          createdAt,
        });
        return;
      }
      case 'run_failed': {
        this.status = 'failed';
        this.completedAt = createdAt;
        this.summary = this.summary ?? (reason || message || 'Run failed.');
        this.pushStep({
          kind: 'error',
          title: 'Run failed',
          content: reason || message || 'Run failed.',
          payload: event.payload ?? {},
          metadata: { sourceEventType: event.type },
          createdAt,
        });
        return;
      }
      default: {
        return;
      }
    }
  }

  toRecord(): NewAgentLoopRecord {
    return {
      projectId: this.input.projectId,
      nodeId: this.input.nodeId ?? null,
      runId: this.input.runId,
      provider: this.input.provider,
      status: this.status,
      userId: this.input.userId ?? null,
      rawInput: this.input.rawInput,
      contextSnapshotId: this.input.contextSnapshotId ?? null,
      summary: this.summary,
      finalOutput: this.finalOutput,
      fileChanges: this.fileChanges,
      metadata: {},
      steps: this.steps,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  private pushStep(step: NewAgentLoopStep): number {
    this.steps.push(step);
    return this.steps.length - 1;
  }

  private appendOrMergeMessage(content: string, createdAt: string): void {
    if (this.lastMessageStep && this.lastMessageStep.kind === 'agent_message') {
      this.lastMessageStep.content += content;
      return;
    }
    const step: NewAgentLoopStep = {
      kind: 'agent_message',
      title: 'Agent message',
      content,
      metadata: { visible: true },
      createdAt,
    };
    this.pushStep(step);
    this.lastMessageStep = step;
    this.lastThoughtStep = null;
  }

  private appendOrMergeThought(content: string, createdAt: string): void {
    if (this.lastThoughtStep && this.lastThoughtStep.kind === 'agent_thought') {
      this.lastThoughtStep.content += content;
      return;
    }
    const step: NewAgentLoopStep = {
      kind: 'agent_thought',
      title: 'Visible thought',
      content,
      metadata: { visible: true },
      createdAt,
    };
    this.pushStep(step);
    this.lastThoughtStep = step;
    this.lastMessageStep = null;
  }

  private extractToolId(event: CoordinatesRunEvent): string | null {
    const message = typeof event.payload?.message === 'string' ? event.payload.message : '';
    const match = message.match(/Tool\s+([A-Za-z0-9_-]+):/) ?? message.match(/Tool call:\s+([A-Za-z0-9_-]+)/);
    return match?.[1] ?? null;
  }
}
