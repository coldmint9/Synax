import type { AgentRun, AgentRunStep, PermissionDecision, ToolCallRecord } from './contracts.js';
import { permissionPolicy, type PermissionPolicy } from './permission-policy.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';

export interface PendingRunResume {
  permission: PermissionDecision;
  run: AgentRun;
  step: AgentRunStep;
  toolCall: ToolCallRecord | null;
}

export class LoopResumeService {
  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly permissions: PermissionPolicy = permissionPolicy,
  ) {}

  resolvePendingPermission(sessionId: string): PermissionDecision | null {
    const session = this.store.getSession(sessionId);
    if (!session.pendingResumeToken) return null;
    return this.permissions.findByResumeToken(sessionId, session.pendingResumeToken) ?? null;
  }

  resolvePendingRun(sessionId: string): PendingRunResume | null {
    const permission = this.resolvePendingPermission(sessionId);
    if (!permission?.runId || !permission.stepId) return null;
    const run = this.store.getRun(permission.runId);
    const step = this.store.getRunStep(permission.stepId);
    const toolCall = permission.toolCallId ? this.store.getToolCall(sessionId, permission.toolCallId) : null;
    return { permission, run, step, toolCall };
  }
}

export const loopResumeService = new LoopResumeService();
