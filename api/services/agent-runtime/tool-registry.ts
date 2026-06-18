import type { PermissionDecision, RegisteredTool, SessionToolProvider, ToolCallRecord, ToolExecutionInput, ToolExecutionResult, ToolHook, ToolHookContext } from './contracts.js';
import * as z from 'zod/v4';
import { evidenceService, type EvidenceService } from './evidence-service.js';
import { agentEventService, type AgentEventService } from './event-service.js';
import { permissionPolicy, type PermissionPolicy } from './permission-policy.js';
import { profileService, type ProfileService } from './profile-service.js';
import { AgentNotFoundError, AgentPermissionError, AgentValidationError } from './runtime-errors.js';
import { sandboxPolicy } from './sandbox/index.js';
import { workspaceRoot } from './tools/workspace.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { agentSessionRuntime } from './session-runtime.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { sessionHooks } from './session-hooks.js';
import { logger } from '../../lib/logger.js';
import { skillRegistry } from './skill-registry.js';
import { ESCALATION_TOOL } from './tool-disclosure.js';
import { INVALID_TOOL, INVALID_TOOL_ID } from './tool-invalid.js';
import { diffReadTool } from './tools/diff-read.js';
import { fileGlobTool } from './tools/file-glob.js';
import { fileListTool } from './tools/file-list.js';
import { filePatchTool } from './tools/file-patch.js';
import { bashTool } from './tools/bash.js';
import { fileReadTool } from './tools/file-read.js';
import { fileDeleteTool } from './tools/file-delete.js';
import { fileWriteTool } from './tools/file-write.js';
import { grepSearchTool } from './tools/grep-search.js';
import { taskCreateTool, taskUpdateTool, taskGetTool, taskListTool } from './tools/task-tools.js';

const SUMMARY_LIMIT = 1_000;

function summarize(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, SUMMARY_LIMIT);
  try {
    return JSON.stringify(value).slice(0, SUMMARY_LIMIT);
  } catch {
    return String(value).slice(0, SUMMARY_LIMIT);
  }
}

export interface ExecuteToolOptions {
  runId?: string | null;
  stepId?: string | null;
  modelToolCallId?: string | null;
  resumeToken?: string | null;
}

export interface ExecuteToolResult {
  record: ToolCallRecord;
  permission?: PermissionDecision;
  toolResult?: ToolExecutionResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly hooks = new Map<string, ToolHook>();
  private readonly providers = new Map<string, SessionToolProvider>();

  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly permissions: PermissionPolicy = permissionPolicy,
    private readonly events: AgentEventService = agentEventService,
    private readonly evidence: EvidenceService = evidenceService,
    private readonly profiles: ProfileService = profileService,
  ) {
    [bashTool, fileReadTool, fileListTool, fileGlobTool, grepSearchTool, diffReadTool, fileWriteTool, filePatchTool, fileDeleteTool, taskCreateTool, taskUpdateTool, taskGetTool, taskListTool, ESCALATION_TOOL, INVALID_TOOL].forEach((tool) =>
      this.register(tool),
    );
    this.register({
      id: 'subagent.delegate',
      label: 'Run Subtask',
      description:
        'Delegate a focused subtask to a child agent with a clean context. Use this when a task would produce large intermediate noise (reading many files, searching, exploring) but the final useful result is just a short summary. The child runs in isolation — its intermediate steps do NOT enter your context, only the final summary returns. Do NOT delegate if: the task is simple (1-2 tool calls), you need the intermediate details for subsequent reasoning, or the task cannot be described in one focused prompt.',
      category: 'task',
      internalGate: 'task',
      mutability: 'task',
      resumeBehavior: 'wait_permission',
      progressiveDetails:
        'Accepts { profileId?: string, prompt: string, nodeId?: string | null, thinkingMode?: "fast" | "standard" | "deep" }. Max depth: 3, max concurrent: 3.',
      inputSchema: z.object({
        profileId: z.string().optional().describe('Child agent profile. Defaults to explorer. Must be a subagent-capable profile.'),
        prompt: z.string().min(1).describe('Bounded prompt for the child agent session.'),
        nodeId: z.string().min(1).nullable().optional().describe('Optional graph node context for the child session.'),
        thinkingMode: z.enum(['fast', 'standard', 'deep']).optional().describe('Child session thinking mode.'),
      }),
      execute: (input) => {
        const MAX_CONCURRENT_SUBTASKS = 3;

        const parent = this.store.getSession(input.sessionId);

        if (parent.parentSessionId) {
          throw new AgentValidationError('Sub-agents cannot delegate further sub-agents.');
        }

        const args = input.args as { profileId?: string; prompt?: string; nodeId?: string | null; thinkingMode?: 'fast' | 'standard' | 'deep' };
        const profileId = args.profileId ?? 'explorer';

        const ALLOWED_SUBTASK_PROFILES = ['explorer', 'reviewer', 'wiki-explorer', 'wiki-verifier', 'wiki-package-explorer'];
        if (!ALLOWED_SUBTASK_PROFILES.includes(profileId)) {
          throw new AgentValidationError(`Subtask profile must be one of: ${ALLOWED_SUBTASK_PROFILES.join(', ')}. Got "${profileId}".`);
        }
        if (!args.prompt?.trim()) throw new AgentValidationError('prompt is required for subagent.delegate.');

        // Concurrency check: count active children of the immediate parent
        const siblings = (parent.childSessionIds ?? [])
          .map(id => { try { return this.store.getSession(id); } catch { return null; } })
          .filter(s => s && s.status === 'running');
        if (siblings.length >= MAX_CONCURRENT_SUBTASKS) {
          throw new AgentValidationError(`Maximum concurrent subtasks (${MAX_CONCURRENT_SUBTASKS}) reached. Wait for existing subtasks to complete.`);
        }

        const child = agentSessionRuntime.create({
          projectId: parent.projectId,
          nodeId: args.nodeId ?? parent.nodeId,
          profileId,
          parentSessionId: parent.id,
          prompt: args.prompt,
          thinkingMode: args.thinkingMode,
        });
        return {
          result: {
            taskId: child.id,
            session: child,
            summary: `Child session ${child.id} (${profileId}) created.`,
          },
          displaySummary: `Started ${profileId} subtask ${child.id}.`,
          artifacts: [
            {
              kind: 'decision',
              title: 'Subtask created',
              summary: `Started ${profileId} child session ${child.id}.`,
              risk: 'low',
            },
          ],
          followUpHints: ['The parent agent blocks until this subtask completes and returns its summary.'],
        };
      },
    });
    this.register({
      id: 'skill.load',
      label: 'Load Skill',
      description: 'Load full skill content after profile filtering and permission evaluation.',
      category: 'skill',
      internalGate: 'skill',
      mutability: 'read',
      resumeBehavior: 'auto',
      progressiveDetails: 'Accepts { skillId: string } and returns full content only after the runtime gate.',
      inputSchema: z.object({
        skillId: z.string().min(1).describe('Skill id to load.'),
      }),
      execute: (input) => {
        const session = this.store.getSession(input.sessionId);
        const profile = this.profiles.get(session.profileId);
        const args = input.args as { skillId?: string };
        if (!args?.skillId) throw new Error('skillId is required.');
        const skill = skillRegistry.loadFull({
          sessionId: input.sessionId,
          skillId: args.skillId,
          profileKind: profile.kind,
        });
        return {
          result: skill,
          displaySummary: `Loaded skill ${skill.id}.`,
          artifacts: [
            {
              kind: 'decision',
              title: 'Skill loaded',
              summary: `Loaded skill ${skill.id}.`,
              risk: 'low',
            },
          ],
        };
      },
    });
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }

  registerHook(hook: ToolHook): void {
    this.hooks.set(hook.id, hook);
  }

  unregisterHook(hookId: string): void {
    this.hooks.delete(hookId);
  }

  registerProvider(provider: SessionToolProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  list(): Array<Omit<RegisteredTool, 'execute'>> {
    return [...this.tools.values()].map(({ execute: _execute, ...summary }) => summary);
  }

  /** List all tools available for a specific session, merging global tools
   *  with session-provider tools. Provider tools shadow global tools with the same ID. */
  listForSession(sessionId: string): Array<Omit<RegisteredTool, 'execute'>> {
    const sessionTools: Array<Omit<RegisteredTool, 'execute'>> = [];
    for (const provider of this.providers.values()) {
      for (const tool of provider.getTools(sessionId)) {
        const { execute: _execute, ...summary } = tool;
        sessionTools.push(summary);
      }
    }
    const seen = new Set(sessionTools.map((t) => t.id));
    const globalTools = [...this.tools.values()]
      .map(({ execute: _execute, ...summary }) => summary)
      .filter((t) => !seen.has(t.id));
    return [...sessionTools, ...globalTools];
  }

  get(toolId: string): RegisteredTool {
    const tool = this.tools.get(toolId);
    if (!tool) throw new AgentNotFoundError(toolId);
    return tool;
  }

  /** Look up a tool by ID, checking session providers first, then global registry. */
  getForSession(sessionId: string, toolId: string): RegisteredTool {
    for (const provider of this.providers.values()) {
      const tools = provider.getTools(sessionId);
      const found = tools.find((t) => t.id === toolId);
      if (found) return found;
    }
    return this.get(toolId);
  }

  async resumePending(sessionId: string, permission: PermissionDecision): Promise<ExecuteToolResult> {
    if (permission.action !== 'allow') {
      throw new AgentValidationError('Only approved permission requests can be resumed.');
    }
    if (!permission.toolCallId) {
      throw new AgentValidationError('Permission resume requires a persisted tool call.');
    }
    const record = this.store.getToolCall(sessionId, permission.toolCallId);
    const tool = this.getForSession(sessionId, record.toolId);
    if (record.status !== 'pending') {
      return { record, permission };
    }
    return this.performExecution(sessionId, tool, record, record.inputRef, permission);
  }

  async execute(sessionId: string, toolId: string, args: unknown, options: ExecuteToolOptions = {}): Promise<ExecuteToolResult> {
    const session = this.store.getSession(sessionId);
    const profile = this.profiles.get(session.profileId);
    const tool = this.getForSession(sessionId, toolId);

    if (!profile.allowedCapabilities.includes(tool.id) && tool.category !== 'skill' && tool.id !== INVALID_TOOL_ID) {
      const errorMsg = `Tool ${tool.id} is not available to profile ${profile.id}. Use only the tools listed in your capabilities.`;
      const now = nowIso();
      const record = this.store.appendToolCall({
        id: makeRuntimeId('tc'),
        sessionId,
        runId: options.runId ?? null,
        stepId: options.stepId ?? null,
        modelToolCallId: options.modelToolCallId ?? null,
        toolId,
        category: tool.category,
        mutability: tool.mutability,
        argsHash: this.store.hashArgs(args),
        inputSummary: summarize(args),
        inputRef: args ?? null,
        outputSummary: errorMsg,
        outputRef: { error: true, message: errorMsg },
        status: 'failed',
        permissionDecisionId: null,
        startedAt: now,
        endedAt: now,
        error: errorMsg,
      });
      return { record, toolResult: { result: { error: true, message: errorMsg }, displaySummary: errorMsg, artifacts: [] } };
    }

    const now = nowIso();
    const record = this.store.appendToolCall({
      id: makeRuntimeId('tc'),
      sessionId,
      runId: options.runId ?? null,
      stepId: options.stepId ?? null,
      modelToolCallId: options.modelToolCallId ?? null,
      toolId,
      category: tool.category,
      mutability: tool.mutability,
      argsHash: this.store.hashArgs(args),
      inputSummary: summarize(args),
      inputRef: args ?? null,
      outputSummary: null,
      outputRef: null,
      status: 'running',
      permissionDecisionId: null,
      startedAt: now,
      endedAt: null,
      error: null,
    });
    this.events.append({
      sessionId,
      type: 'tool_call',
      summary: `Tool ${tool.id} started`,
      payload: {
        runId: options.runId ?? null,
        stepId: options.stepId ?? null,
        toolCallId: record.id,
        toolId: tool.id,
        category: tool.category,
        mutability: tool.mutability,
      },
    });

    const decision = this.permissions.evaluate({
      sessionId,
      runId: options.runId ?? null,
      stepId: options.stepId ?? null,
      toolCallId: record.id,
      category: tool.category,
      internalGate: tool.internalGate ?? 'none',
      pattern: tool.getPattern?.(args) ?? tool.patterns?.[0] ?? tool.id,
      rules: session.permissionRules,
      isSubSession: Boolean(session.parentSessionId),
      resumeToken: options.resumeToken ?? null,
      metadata: {
        toolId: tool.id,
        args,
        mutability: tool.mutability,
      },
    });
    this.store.updateToolCall(sessionId, record.id, { permissionDecisionId: decision.id });

    if (decision.action === 'ask') {
      this.store.updateSession(sessionId, {
        status: 'waiting_permission',
        updatedAt: nowIso(),
        pendingResumeToken: decision.resumeToken,
      });
      this.events.append({
        sessionId,
        type: 'permission_requested',
        summary: decision.reason,
        payload: {
          runId: options.runId ?? null,
          stepId: options.stepId ?? null,
          permissionId: decision.id,
          toolCallId: record.id,
          internalGate: decision.internalGate,
        },
      });
      return {
        record: this.store.updateToolCall(sessionId, record.id, { status: 'pending' }),
        permission: decision,
      };
    }

    if (decision.action === 'deny') {
      this.events.append({
        sessionId,
        type: 'permission_resolved',
        summary: decision.reason,
        payload: { permissionId: decision.id, action: 'deny', toolCallId: record.id },
      });
      return {
        record: this.store.updateToolCall(sessionId, record.id, {
          status: 'denied',
          endedAt: nowIso(),
          error: decision.reason,
        }),
        permission: decision,
      };
    }

    return this.performExecution(sessionId, tool, record, args, decision);
  }

  private async performExecution(
    sessionId: string,
    tool: RegisteredTool,
    record: ToolCallRecord,
    args: unknown,
    permission?: PermissionDecision,
  ): Promise<ExecuteToolResult> {
    try {
      const running = record.status === 'running'
        ? record
        : this.store.updateToolCall(sessionId, record.id, {
            status: 'running',
            endedAt: null,
            error: null,
            outputSummary: null,
            outputRef: null,
          });
      const input: ToolExecutionInput = {
        sessionId,
        runId: running.runId,
        stepId: running.stepId,
        toolCallId: running.id,
        toolId: running.toolId,
        category: running.category,
        mutability: running.mutability,
        args,
        pattern: tool.getPattern?.(args) ?? tool.patterns?.[0] ?? tool.id,
      };
      const hookCtx: ToolHookContext = { sessionId, runId: running.runId, stepId: running.stepId, toolCallId: running.id, toolId: running.toolId, args, result: null! };
      void sessionHooks.emit({ type: 'tool:before', ctx: hookCtx });
      sandboxPolicy.validateToolArgs(running.toolId, args, workspaceRoot(sessionId), sessionId);
      const result = await tool.execute(input);
      const outputSummary = result.displaySummary.slice(0, SUMMARY_LIMIT);
      const status = result.displaySummary.length > SUMMARY_LIMIT ? 'compacted' : 'completed';

      for (const artifact of result.artifacts) {
        this.evidence.append({
          sessionId,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
          sourceRefs: [{ type: 'tool_call', id: running.id }],
          risk: artifact.risk ?? 'unknown',
          metadata: artifact.metadata,
        });
      }

      const completed = this.store.updateToolCall(sessionId, running.id, {
        status,
        outputSummary,
        outputRef: result.result ?? null,
        endedAt: nowIso(),
      });

      await this.fireHooks({
        sessionId,
        runId: running.runId,
        stepId: running.stepId,
        toolCallId: running.id,
        toolId: running.toolId,
        args,
        result,
      });
      void sessionHooks.emit({ type: 'tool:after', ctx: { sessionId, runId: running.runId, stepId: running.stepId, toolCallId: running.id, toolId: running.toolId, args, result } });

      this.events.append({
        sessionId,
        type: 'tool_result',
        summary: `${tool.id}: ${outputSummary}`,
        payload: {
          runId: completed.runId,
          stepId: completed.stepId,
          toolCallId: completed.id,
          status,
          followUpHints: result.followUpHints ?? [],
        },
      });
      return { record: completed, permission, toolResult: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.updateToolCall(sessionId, record.id, {
        status: error instanceof AgentPermissionError ? 'denied' : 'failed',
        endedAt: nowIso(),
        error: message,
      });
      // A failed tool call is a SIGNAL, not a session death sentence. The failure
      // is surfaced to the model as a tool_result so it can self-correct (change
      // approach, fix args, switch tools). Consecutive same-tool failures trigger
      // a corrective system-reminder (see buildConsecutiveFailureReminder), and
      // genuine no-progress loops are caught by detectDoomLoop. We deliberately do
      // NOT block the session on a failure count.
      this.events.append({
        sessionId,
        type: 'tool_result',
        summary: `${tool.id} failed: ${message}`,
        payload: {
          runId: failed.runId,
          stepId: failed.stepId,
          toolCallId: failed.id,
          status: failed.status,
          error: message,
        },
      });
      return { record: failed, permission };
    }
  }

  private async fireHooks(ctx: ToolHookContext): Promise<void> {
    // Collect hooks from both session providers and global registry
    const allHooks: ToolHook[] = [...this.hooks.values()];
    for (const provider of this.providers.values()) {
      allHooks.push(...provider.getHooks(ctx.sessionId));
    }
    for (const hook of allHooks) {
      if (hook.toolId !== '*' && hook.toolId !== ctx.toolId) continue;
      try {
        await hook.afterExecute(ctx);
      } catch (err) {
        logger.warn({ hookId: hook.id, toolId: ctx.toolId, err },
          '[tool-registry] hook afterExecute failed');
      }
    }
  }
}

export const toolRegistry = new ToolRegistry();
