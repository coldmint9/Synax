import type {
  CapabilityCategory,
  InternalGate,
  PermissionAction,
  PermissionDecision,
  PermissionReply,
  PermissionRule,
} from "./contracts.js";
import { reviewOperation, type OperationReview } from "./operation-approval.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { AgentNotFoundError, AgentPermissionError } from "./runtime-errors.js";
import { appendAlwaysPermissionRule } from "./session-permissions.js";
import { grantProjectTool, grantedToolId } from "./project-tool-grants.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { matchWildcard } from "./wildcard.js";
import {
  parseBashInvocations,
  type BashInvocation,
} from "./tools/bash-command-policy.js";

function strictestPermissionAction(
  actions: PermissionAction[],
): PermissionAction {
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  return "allow";
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

function coarseCategory(
  category: CapabilityCategory,
): PermissionDecision["coarseCategory"] {
  if (
    category === "read" ||
    category === "context" ||
    category === "review" ||
    category === "skill"
  )
    return "read";
  if (category === "write") return "write";
  if (
    category === "external_execution" ||
    category === "task" ||
    category === "mcp"
  )
    return "external_execution";
  return "high_risk";
}

function matches(rule: PermissionRule, input: PermissionRequestInput): boolean {
  // `gate: 'task'` controls subagent delegation (`internalGate: 'task'`), not session TODO tools (`task.*`).
  if (rule.gate === "task") {
    if (input.internalGate !== "task") return false;
  } else if (
    rule.gate !== "*" &&
    rule.gate !== input.category &&
    rule.gate !== (input.internalGate ?? "none")
  ) {
    return false;
  }
  return matchWildcard(input.pattern ?? "*", rule.pattern);
}

function defaultDecision(input: PermissionRequestInput): {
  action: PermissionAction;
  reason: string;
} {
  if (input.internalGate === "shell" || input.category === "shell") {
    return {
      action: "ask",
      reason: "Shell commands require explicit approval by default.",
    };
  }
  if (input.isSubSession && input.internalGate === "task") {
    return {
      action: "deny",
      reason: "Child sessions cannot recursively delegate tasks in v1.",
    };
  }
  if (input.category === "task" && input.internalGate !== "task") {
    return {
      action: "allow",
      reason: "Session task tools do not require approval.",
    };
  }
  if (
    input.isSubSession &&
    (input.category === "write" || input.internalGate === "write")
  ) {
    return {
      action: "deny",
      reason: "v1 sub-sessions cannot write source files.",
    };
  }
  if (input.internalGate === "write" || input.category === "write") {
    return { action: "ask", reason: "Writes require explicit approval." };
  }
  if (input.internalGate === "delete") {
    return { action: "ask", reason: "Deletes require explicit approval." };
  }
  if (input.internalGate === "task") {
    return {
      action: "allow",
      reason: "Subagent delegation is allowed by default.",
    };
  }
  if (input.internalGate === "external_path") {
    return {
      action: "ask",
      reason: "Project-external path access requires approval.",
    };
  }
  if (input.category === "mcp") {
    return {
      action: "ask",
      reason: "MCP tools require explicit approval by default.",
    };
  }
  if (input.category === "external_execution") {
    return {
      action: "deny",
      reason: "External execution is not part of the v1 runtime path.",
    };
  }
  if (input.internalGate === "skill" || input.category === "skill") {
    return {
      action: "allow",
      reason: "Skill metadata may be loaded after profile filtering.",
    };
  }
  if (
    input.category === "read" ||
    input.category === "context" ||
    input.category === "review"
  ) {
    return { action: "allow", reason: "Project-contained read is allowed." };
  }
  return { action: "ask", reason: "High-risk action requires approval." };
}

/** A project grant may satisfy asks, never a deny (including a parent's inherited deny). */
export function isProjectToolGrantDenied(
  input: PermissionRequestInput,
  shellCommand?: string,
): boolean {
  const shell = shellCommand !== undefined;
  const checked = shell
    ? { ...input, category: "shell" as const, internalGate: "shell" as const }
    : input;
  if (defaultDecision(checked).action === "deny") return true;
  const patterns = shell
    ? parseBashInvocations(shellCommand).flatMap((invocation) =>
        [invocation.pattern, invocation.risk, "*"])
    : [input.pattern ?? "*"];
  return (input.rules ?? []).some((rule) => rule.action === "deny" &&
    patterns.some((pattern) => matches(rule, { ...checked, pattern })));
}

export function resolvePermissionDecision(
  input: PermissionRequestInput,
  review: OperationReview | null = reviewOperation(input),
): { action: PermissionAction; reason: string } {
  const matching = (input.rules ?? []).filter((candidate) => matches(candidate, input));
  const rule = matching.at(-1);
  const fallback = defaultDecision(input);
  if (grantedToolId(input)) {
    if (isProjectToolGrantDenied(input))
      return { action: "deny", reason: "An explicit permission restriction denies this tool." };
    return { action: "allow", reason: "Project-wide tool approval." };
  }
  const decision = {
    action: rule?.action ?? fallback.action,
    reason: rule?.reason ?? fallback.reason,
  };
  return review && decision.action !== "deny" && (review.action !== "allow" || decision.action === "allow")
    ? { action: review.action, reason: review.reason }
    : decision;
}

function reviewReplies(metadata?: Record<string, unknown>, toolCallId?: string | null): string[] {
  const supported = metadata?.allowedReplies;
  const choices = !metadata?.source && toolCallId && typeof metadata?.toolId === 'string'
    ? ['once', 'always', 'reject'] : ['once', 'reject'];
  return choices.filter(reply => !Array.isArray(supported) || supported.includes(reply));
}

export class PermissionPolicy {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  private resolveShellInvocation(
    invocation: BashInvocation,
    input: Omit<PermissionRequestInput, "pattern">,
  ): { action: PermissionAction; reason: string; pattern: string } {
    const shellInput: PermissionRequestInput = {
      ...input,
      category: "shell",
      internalGate: "shell",
    };
    const patternCandidates = [invocation.pattern, invocation.risk, "*"];
    for (const pattern of patternCandidates) {
      const rule = [...(input.rules ?? [])]
        .reverse()
        .find((candidate) => matches(candidate, { ...shellInput, pattern }));
      if (rule) {
        return {
          action: rule.action,
          reason: rule.reason ?? "Shell command matched a permission rule.",
          pattern,
        };
      }
    }
    const fallback = defaultDecision({
      ...shellInput,
      pattern: invocation.pattern,
    });
    return {
      action: fallback.action,
      reason: fallback.reason,
      pattern: invocation.pattern,
    };
  }

  evaluateShellCommand(
    input: Omit<PermissionRequestInput, "pattern"> & { command: string },
  ): PermissionDecision {
    const invocations = parseBashInvocations(input.command);
    const evaluated = (
      invocations.length > 0
        ? invocations
        : [
            {
              command: "*",
              subcommand: null,
              pattern: "*",
              risk: "write" as const,
            },
          ]
    ).map((invocation) => this.resolveShellInvocation(invocation, input));

    const baseAction = strictestPermissionAction(
      evaluated.map((item) => item.action),
    );
    const matched =
      evaluated.find((item) => item.action === baseAction) ?? evaluated[0]!;
    const review = reviewOperation({
      ...input,
      metadata: { ...input.metadata, command: input.command },
    });
    const granted = grantedToolId(input);
    const explicitDenial = granted && isProjectToolGrantDenied(input, input.command);
    const action = explicitDenial ? "deny" : granted ? "allow" :
      baseAction === "deny" ? baseAction : (review?.action ?? baseAction);
    const reason =
      explicitDenial ? "An explicit permission restriction denies this tool." :
      granted ? "Project-wide tool approval." :
      baseAction === "deny"
        ? matched.reason
        : (review?.reason ?? matched.reason);
    const patterns = invocations.map((invocation) => invocation.pattern);
    const now = nowIso();

    return this.store.appendPermission({
      id: makeRuntimeId("pd"),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      coarseCategory: "high_risk",
      internalGate: review?.gate ?? "shell",
      action,
      reason,
      patterns: patterns.length > 0 ? patterns : ["*"],
      userReply:
        action === "ask" ? null : action === "allow" ? "once" : "reject",
      createdAt: now,
      resolvedAt: action === "ask" ? null : now,
      resumeToken: input.resumeToken ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        command: input.command,
        invocations,
        ...(review
          ? { approvalPaths: review.paths, allowedReplies: reviewReplies(input.metadata, input.toolCallId) }
          : {}),
        ...(granted && action === "allow" ? { projectToolGrant: true } : {}),
        ...(!review && action === "ask" && !input.metadata?.source
          ? { allowedReplies: reviewReplies(input.metadata, input.toolCallId) } : {}),
      },
    });
  }

  evaluate(input: PermissionRequestInput): PermissionDecision {
    const review = reviewOperation(input);
    const { action, reason } = resolvePermissionDecision(input, review);
    const granted = grantedToolId(input);
    const now = nowIso();
    return this.store.appendPermission({
      id: makeRuntimeId("pd"),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      coarseCategory: coarseCategory(input.category),
      internalGate: review?.gate ?? input.internalGate ?? "none",
      action,
      reason,
      patterns: [input.pattern ?? "*"],
      userReply:
        action === "ask" ? null : action === "allow" ? "once" : "reject",
      createdAt: now,
      resolvedAt: action === "ask" ? null : now,
      resumeToken: input.resumeToken ?? null,
      metadata: {
        ...input.metadata,
        ...(review
          ? { approvalPaths: review.paths, allowedReplies: reviewReplies(input.metadata, input.toolCallId) }
          : {}),
        ...(granted && action === "allow" ? { projectToolGrant: true } : {}),
        ...(!review && action === "ask" && !input.metadata?.source
          ? { allowedReplies: reviewReplies(input.metadata, input.toolCallId) } : {}),
      },
    });
  }

  reply(
    sessionId: string,
    permissionId: string,
    reply: PermissionReply,
    message?: string,
    persistRule = true,
  ): PermissionDecision {
    const decision = this.list(sessionId).find(
      (item) => item.id === permissionId,
    );
    if (!decision) throw new AgentNotFoundError(permissionId);
    if (
      decision.resolvedAt &&
      decision.userReply !== null &&
      decision.action !== "ask"
    ) {
      throw new AgentPermissionError(
        "Permission request is already resolved.",
        400,
      );
    }
    const allowedReplies = decision.metadata?.allowedReplies;
    if (Array.isArray(allowedReplies) && !allowedReplies.includes(reply)) {
      throw new AgentPermissionError(
        "This reply is not supported by this approval request.",
        400,
      );
    }
    return runtimeTransaction(() => {
      const action: PermissionAction = reply === "reject" ? "deny" : "allow";
      const toolId = decision.metadata?.toolId;
      if (reply === "always" && persistRule && typeof toolId === "string") {
        const toolCall = decision.toolCallId && this.store.getToolCall(sessionId, decision.toolCallId);
        if (!toolCall || toolCall.toolId !== toolId || decision.metadata?.source)
          throw new AgentPermissionError("Project approval requires a registered native tool call.", 400);
        grantProjectTool(sessionId, toolId, permissionId);
      }
      const updated = this.store.updatePermission(sessionId, permissionId, {
        action,
        userReply: reply,
        resolvedAt: nowIso(),
        reason: message ? `${decision.reason} ${message}` : decision.reason,
      });
      if (reply === "always" && persistRule && typeof toolId !== "string") {
        const pattern = decision.patterns[0] ?? "*";
        const gate = decision.internalGate === "none"
          ? decision.coarseCategory : decision.internalGate;
        appendAlwaysPermissionRule(sessionId, {
          gate, pattern, action, reason: updated.reason,
        });
      }
      return updated;
    });
  }

  list(sessionId: string): PermissionDecision[] {
    return this.store.listPermissions(sessionId);
  }

  findByResumeToken(
    sessionId: string,
    resumeToken: string,
  ): PermissionDecision | undefined {
    return this.store.findPermissionByResumeToken(sessionId, resumeToken);
  }
}

export const permissionPolicy = new PermissionPolicy();
