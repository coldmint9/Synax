import type {
  CapabilityCategory,
  InternalGate,
  PermissionAction,
  PermissionDecision,
  PermissionReply,
  PermissionRule,
} from './contracts.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { AgentNotFoundError, AgentPermissionError } from './runtime-errors.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { matchWildcard } from './wildcard.js';
import { parseBashInvocations, type BashInvocation } from './tools/bash-command-policy.js';

function strictestPermissionAction(actions: PermissionAction[]): PermissionAction {
  if (actions.includes('deny')) return 'deny';
  if (actions.includes('ask')) return 'ask';
  return 'allow';
}

export interface PermissionRequestInput {
  sessionId: string;
  runId?: string | null;
  stepId?: string | null;
  toolCallId?: string | null;
  category: CapabilityCategory;
  internalGate?: InternalGate;
  pattern?: string;
  rules?: PermissionRule[];
  isSubSession?: boolean;
  resumeToken?: string | null;
  metadata?: Record<string, unknown>;
}

function coarseCategory(category: CapabilityCategory): PermissionDecision['coarseCategory'] {
  if (category === 'read' || category === 'context' || category === 'review' || category === 'skill') return 'read';
  if (category === 'write') return 'write';
  if (category === 'external_execution' || category === 'task') return 'external_execution';
  return 'high_risk';
}

function matches(rule: PermissionRule, input: PermissionRequestInput): boolean {
  // `gate: 'task'` controls subagent delegation (`internalGate: 'task'`), not session TODO tools (`task.*`).
  if (rule.gate === 'task') {
    if (input.internalGate !== 'task') return false;
  } else if (rule.gate !== '*' && rule.gate !== input.category && rule.gate !== (input.internalGate ?? 'none')) {
    return false;
  }
  return matchWildcard(input.pattern ?? '*', rule.pattern);
}

function defaultDecision(input: PermissionRequestInput): { action: PermissionAction; reason: string } {
  if (input.internalGate === 'shell' || input.category === 'shell') {
    return { action: 'ask', reason: 'Shell commands require explicit approval by default.' };
  }
  if (input.isSubSession && input.internalGate === 'task') {
    return { action: 'deny', reason: 'Child sessions cannot recursively delegate tasks in v1.' };
  }
  if (input.category === 'task' && input.internalGate !== 'task') {
    return { action: 'allow', reason: 'Session task tools do not require approval.' };
  }
  if (input.isSubSession && (input.category === 'write' || input.internalGate === 'write')) {
    return { action: 'deny', reason: 'v1 sub-sessions cannot write source files.' };
  }
  if (input.internalGate === 'write' || input.category === 'write') {
    return { action: 'ask', reason: 'Writes require explicit approval.' };
  }
  if (input.internalGate === 'delete') {
    return { action: 'ask', reason: 'Deletes require explicit approval.' };
  }
  if (input.internalGate === 'task') {
    return { action: 'allow', reason: 'Subagent delegation is allowed by default.' };
  }
  if (input.internalGate === 'external_path') {
    return { action: 'ask', reason: 'Project-external path access requires approval.' };
  }
  if (input.category === 'external_execution') {
    return { action: 'deny', reason: 'External execution is not part of the v1 runtime path.' };
  }
  if (input.internalGate === 'skill' || input.category === 'skill') {
    return { action: 'allow', reason: 'Skill metadata may be loaded after profile filtering.' };
  }
  if (input.category === 'read' || input.category === 'context' || input.category === 'review') {
    return { action: 'allow', reason: 'Project-contained read is allowed.' };
  }
  return { action: 'ask', reason: 'High-risk action requires approval.' };
}

export class PermissionPolicy {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  private resolveShellInvocation(
    invocation: BashInvocation,
    input: Omit<PermissionRequestInput, 'pattern'>,
  ): { action: PermissionAction; reason: string; pattern: string } {
    const shellInput: PermissionRequestInput = {
      ...input,
      category: 'shell',
      internalGate: 'shell',
    };
    const patternCandidates = [invocation.pattern, invocation.risk, '*'];
    for (const pattern of patternCandidates) {
      const rule = [...(input.rules ?? [])]
        .reverse()
        .find((candidate) => matches(candidate, { ...shellInput, pattern }));
      if (rule) {
        return {
          action: rule.action,
          reason: rule.reason ?? 'Shell command matched a permission rule.',
          pattern,
        };
      }
    }
    const fallback = defaultDecision({ ...shellInput, pattern: invocation.pattern });
    return { action: fallback.action, reason: fallback.reason, pattern: invocation.pattern };
  }

  evaluateShellCommand(input: Omit<PermissionRequestInput, 'pattern'> & { command: string }): PermissionDecision {
    const invocations = parseBashInvocations(input.command);
    const evaluated = (invocations.length > 0 ? invocations : [{
      command: '*',
      subcommand: null,
      pattern: '*',
      risk: 'write' as const,
    }]).map((invocation) => this.resolveShellInvocation(invocation, input));

    const action = strictestPermissionAction(evaluated.map((item) => item.action));
    const matched = evaluated.find((item) => item.action === action) ?? evaluated[0]!;
    const reason = matched.reason;
    const patterns = invocations.map((invocation) => invocation.pattern);
    const now = nowIso();

    return this.store.appendPermission({
      id: makeRuntimeId('pd'),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      coarseCategory: 'high_risk',
      internalGate: 'shell',
      action,
      reason,
      patterns: patterns.length > 0 ? patterns : ['*'],
      userReply: action === 'ask' ? null : action === 'allow' ? 'once' : 'reject',
      createdAt: now,
      resolvedAt: action === 'ask' ? null : now,
      resumeToken: input.resumeToken ?? null,
      metadata: {
        ...input.metadata ?? {},
        command: input.command,
        invocations,
      },
    });
  }

  evaluate(input: PermissionRequestInput): PermissionDecision {
    const rule = [...(input.rules ?? [])].reverse().find((candidate) => matches(candidate, input));
    const fallback = defaultDecision(input);
    const action = rule?.action ?? fallback.action;
    const reason = rule?.reason ?? fallback.reason;
    const now = nowIso();
    return this.store.appendPermission({
      id: makeRuntimeId('pd'),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      coarseCategory: coarseCategory(input.category),
      internalGate: input.internalGate ?? 'none',
      action,
      reason,
      patterns: [input.pattern ?? '*'],
      userReply: action === 'ask' ? null : action === 'allow' ? 'once' : 'reject',
      createdAt: now,
      resolvedAt: action === 'ask' ? null : now,
      resumeToken: input.resumeToken ?? null,
      metadata: input.metadata ?? {},
    });
  }

  reply(sessionId: string, permissionId: string, reply: PermissionReply, message?: string): PermissionDecision {
    const decision = this.list(sessionId).find((item) => item.id === permissionId);
    if (!decision) throw new AgentNotFoundError(permissionId);
    if (decision.resolvedAt && decision.userReply !== null && decision.action !== 'ask') {
      throw new AgentPermissionError('Permission request is already resolved.', 400);
    }
    const action: PermissionAction = reply === 'reject' ? 'deny' : 'allow';
    const updated = this.store.updatePermission(sessionId, permissionId, {
      action,
      userReply: reply,
      resolvedAt: nowIso(),
      reason: message ? `${decision.reason} ${message}` : decision.reason,
    });
    if (reply === 'always') {
      const session = this.store.getSession(sessionId);
      const pattern = decision.patterns[0] ?? '*';
      const gate = decision.internalGate === 'none' ? decision.coarseCategory : decision.internalGate;
      const permissionRules = [...session.permissionRules, { gate, pattern, action, reason: updated.reason }];
      this.store.updateSession(sessionId, {
        permissionRules,
        updatedAt: nowIso(),
        pendingResumeToken: decision.resumeToken ?? null,
      });
    }
    return updated;
  }

  list(sessionId: string): PermissionDecision[] {
    return this.store.listPermissions(sessionId);
  }

  findByResumeToken(sessionId: string, resumeToken: string): PermissionDecision | undefined {
    return this.store.findPermissionByResumeToken(sessionId, resumeToken);
  }
}

export const permissionPolicy = new PermissionPolicy();
