import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type {
  CapabilityCategory,
  InternalGate,
  PermissionDecision,
  PermissionReply,
  ToolCallRecord,
} from '../contracts.js';
import { permissionPolicy } from '../permission-policy.js';
import { agentRuntimeStore } from '../session-store.js';
import { makeRuntimeId } from '../runtime-ids.js';
import { logger } from '../../../lib/logger.js';

type PermissionResolver = (response: RequestPermissionResponse) => void;

interface PendingAcpPermission {
  sessionId: string;
  permissionId: string;
  options: PermissionOption[];
  resolve: PermissionResolver;
}

export interface AcpPermissionTurnContext {
  sessionId: string;
  runId: string;
  stepId: string;
  rules: import('../contracts.js').PermissionRule[];
  isSubSession: boolean;
  onPermissionRequested: (
    decision: PermissionDecision,
    toolCall: ToolCallRecord,
  ) => void;
}

export class AcpPermissionBridge {
  private readonly pending = new Map<string, PendingAcpPermission>();
  private readonly turnContext = new Map<string, AcpPermissionTurnContext>();

  setTurnContext(sessionId: string, context: AcpPermissionTurnContext): void {
    this.turnContext.set(sessionId, context);
  }

  clearTurnContext(sessionId: string): void {
    this.turnContext.delete(sessionId);
  }

  async handleRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const context = this.turnContext.get(params.sessionId);
    if (!context) {
      const first = params.options[0];
      if (!first) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: first.optionId } };
    }

    const toolCallRecord = agentRuntimeStore.appendToolCall({
      id: makeRuntimeId('tc'),
      sessionId: context.sessionId,
      runId: context.runId,
      stepId: context.stepId,
      modelToolCallId: params.toolCall.toolCallId,
      toolId: `acp.${params.toolCall.kind ?? 'other'}`,
      category: mapToolKindToGate(params.toolCall.kind, params.toolCall.title).category,
      mutability: 'write',
      argsHash: JSON.stringify(params.toolCall.rawInput ?? {}),
      inputSummary: params.toolCall.title ?? params.toolCall.kind ?? 'permission_request',
      inputRef: params.toolCall.rawInput ?? null,
      outputSummary: null,
      outputRef: null,
      status: 'pending',
      permissionDecisionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
    });

    const mapped = mapToolKindToGate(params.toolCall.kind, params.toolCall.title);
    const decision = permissionPolicy.evaluate({
      sessionId: context.sessionId,
      runId: context.runId,
      stepId: context.stepId,
      toolCallId: toolCallRecord.id,
      category: mapped.category,
      internalGate: mapped.internalGate,
      pattern: mapped.pattern,
      rules: context.rules,
      isSubSession: context.isSubSession,
      resumeToken: makeRuntimeId('acp_perm'),
      metadata: {
        source: 'acp',
        acpToolCallId: params.toolCall.toolCallId,
        acpTitle: params.toolCall.title ?? null,
        acpKind: params.toolCall.kind ?? null,
      },
    });

    agentRuntimeStore.updateToolCall(context.sessionId, toolCallRecord.id, {
      permissionDecisionId: decision.id,
    });

    if (decision.action === 'allow') {
      return toAcpResponse(params.options, 'once');
    }
    if (decision.action === 'deny') {
      return toAcpResponse(params.options, 'reject');
    }

    agentRuntimeStore.updateSession(context.sessionId, {
      status: 'waiting_permission',
      pendingResumeToken: decision.resumeToken,
      updatedAt: new Date().toISOString(),
    });
    context.onPermissionRequested(decision, toolCallRecord);

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(decision.id, {
        sessionId: context.sessionId,
        permissionId: decision.id,
        options: params.options,
        resolve,
      });
      logger.info(
        {
          sessionId: context.sessionId,
          permissionId: decision.id,
          acpToolCallId: params.toolCall.toolCallId,
        },
        '[AcpPermissionBridge] waiting for user permission reply',
      );
    });
  }

  resolve(sessionId: string, permissionId: string, reply: PermissionReply): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.pending.delete(permissionId);
    pending.resolve(toAcpResponse(pending.options, reply));
    return true;
  }

  rejectAllForSession(sessionId: string, reason = 'Session interrupted.'): void {
    for (const [permissionId, pending] of this.pending.entries()) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(permissionId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      logger.info(
        { sessionId, permissionId, reason },
        '[AcpPermissionBridge] cancelled pending permission',
      );
    }
  }

  hasPendingForSession(sessionId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }
}

export const acpPermissionBridge = new AcpPermissionBridge();

function mapToolKindToGate(kind: ToolKind | null | undefined, title: string | null | undefined): {
  category: CapabilityCategory;
  internalGate: InternalGate;
  pattern: string;
} {
  const label = `${kind ?? ''} ${title ?? ''}`.toLowerCase();
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return { category: 'read', internalGate: 'none', pattern: title ?? '*' };
    case 'edit':
    case 'move':
      return { category: 'write', internalGate: 'write', pattern: title ?? '*' };
    case 'delete':
      return { category: 'write', internalGate: 'delete', pattern: title ?? '*' };
    case 'execute':
      return { category: 'shell', internalGate: 'shell', pattern: title ?? '*' };
    default:
      if (label.includes('bash') || label.includes('shell') || label.includes('terminal')) {
        return { category: 'shell', internalGate: 'shell', pattern: title ?? '*' };
      }
      if (label.includes('write') || label.includes('edit') || label.includes('patch')) {
        return { category: 'write', internalGate: 'write', pattern: title ?? '*' };
      }
      if (label.includes('delete') || label.includes('remove')) {
        return { category: 'write', internalGate: 'delete', pattern: title ?? '*' };
      }
      if (label.includes('read') || label.includes('grep') || label.includes('search')) {
        return { category: 'read', internalGate: 'none', pattern: title ?? '*' };
      }
      return { category: 'high_risk', internalGate: 'none', pattern: title ?? '*' };
  }
}

function pickOption(
  options: PermissionOption[],
  reply: PermissionReply,
): PermissionOption | null {
  if (options.length === 0) return null;
  if (reply === 'reject') {
    return options.find((item) => item.kind.startsWith('reject'))
      ?? options.find((item) => item.kind === 'allow_once')
      ?? options[0]!;
  }
  if (reply === 'always') {
    return options.find((item) => item.kind === 'allow_always')
      ?? options.find((item) => item.kind === 'allow_once')
      ?? options[0]!;
  }
  return options.find((item) => item.kind === 'allow_once')
    ?? options.find((item) => item.kind.startsWith('allow'))
    ?? options[0]!;
}

function toAcpResponse(
  options: PermissionOption[],
  reply: PermissionReply,
): RequestPermissionResponse {
  if (reply === 'reject') {
    const rejectOption = options.find((item) => item.kind.startsWith('reject'));
    if (rejectOption) {
      return {
        outcome: { outcome: 'selected', optionId: rejectOption.optionId },
      };
    }
    return { outcome: { outcome: 'cancelled' } };
  }
  const selected = pickOption(options, reply);
  if (!selected) return { outcome: { outcome: 'cancelled' } };
  return {
    outcome: { outcome: 'selected', optionId: selected.optionId },
  };
}
