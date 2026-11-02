import { rememberLoadedSkill } from "./skill-context.js";
import { withToolResource } from "./resource-admission.js";
import { CommandTasks } from "./command-tasks.js";
import { businessStore } from "../../infrastructure/persistence/business-store.js";
import { hydrateRuntimeAssets } from "./media-assets.js";
import { waitForCodeRead } from "./code-mode/cancellation.js";
import { createCodeTools } from "./code-mode/tools.js";
import { NativeCapabilities } from "./native-capabilities/service.js";
import { canComposeTool } from "./code-mode/policy.js";
import { codeParentId } from "./code-mode/history.js";
import { extensionStore } from "../extensions/extension-store.js";
import { customToolProvider } from "../extensions/custom-tool-provider.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";
import { PatchApplyError } from "./tools/patch-diagnostics.js";
import { resolveWorkspacePath as resolveUndoPath } from "./tools/workspace.js";
import { withWorkspaceMutation } from "./workspace-mutation.js";
import { assertHistoryUnlocked } from "./runtime-history.js";
import { mediaReadTool } from "./tools/media-read.js";
import { mediaGenerateTool } from "./tools/media-generate.js";
import { mediaAudioVideoTools } from "./tools/media-audio-video.js";
import { mediaJobsTools } from "./tools/media-jobs.js";
import { assertRuntimeExecutionCurrent, isExecutionSuperseded, currentExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { workTools } from "./tools/work-tools.js";
import { verificationTool } from "./tools/verification.js";
import { workRuntime } from "./work-runtime.js";
import { workStore } from "./work-store.js";
import { bashUsesInspectionCapacity } from "./tools/bash-command-policy.js";
import { withCommandSignal } from "./tools/exec-async.js";
import { resolvePermissionDecision, isProjectToolGrantDenied } from "./permission-policy.js";
import {
  assertSpecialistToolAllowed,
} from "./specialist-profile.js";
import { controlTools } from "./control-tools.js";
import { delegateArgsSchema, delegateSubagent } from "./subagent-delegation.js";
import { assertSubagentToolAllowed } from "./subagent-profile.js";
import { subagentLifecycleTools } from "./subagent-tools.js";
import { readSubagentControl } from "./subagent-control-broker.js";
import { controlToolError } from "./control-policy.js";
import { isInteractiveSideChat } from "./side-chat-contract.js";
import { presentationTool } from "./presentation-runtime.js";
import { interactionService } from "./interaction-service.js";
import type {
  PermissionDecision,
  RegisteredTool,
  SessionToolProvider,
  ToolCallRecord,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolHook,
  ToolHookContext,
} from "./contracts.js";
import * as z from "zod/v4";
import { evidenceService, type EvidenceService } from "./evidence-service.js";
import { agentEventService, type AgentEventService } from "./event-service.js";
import {
  permissionPolicy,
  type PermissionPolicy,
} from "./permission-policy.js";
import { profileService, type ProfileService } from "./profile-service.js";
import {
  AgentToolNotFoundError,
  AgentPermissionError,
  AgentValidationError,
  isToolResolutionError,
} from "./runtime-errors.js";
import { sandboxPolicy, withSandboxApproval, withProjectToolApproval } from "./sandbox/index.js";
import { hasProjectToolGrant } from "./project-tool-grants.js";
import { workspaceRoot } from "./tools/workspace.js";
import { invalidateSessionEnvironment } from "./session-environment.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { sessionHooks } from "./session-hooks.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { emitSessionLive } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { mcpSessionToolProvider } from "../../infrastructure/mcp/mcp-session-tool-provider.js";
import { jevSessionToolProvider } from "../computer-use/jev-tool-provider.js";
import { INVALID_TOOL, INVALID_TOOL_ID } from "./tool-invalid.js";
import { resolveToolName } from "./tool-name-resolution.js";
import { diffReadTool } from "./tools/diff-read.js";
import { fileListTool } from "./tools/file-list.js";
import { patchTool } from "./tools/patch.js";
import { bashTool } from "./tools/bash.js";
import { fileReadTool } from "./tools/file-read.js";
import { fileDeleteTool } from "./tools/file-delete.js";
import { fileWriteTool } from "./tools/file-write.js";
import { fileGenerateTool } from "./tools/file-generate.js";
import { pythonRunTool } from "./tools/python-run.js";
import { runTool } from "./tools/run.js";
import { prepareRunArgs } from "./script-execution/run-schema.js";
import { resolvePythonRuntime } from "../../infrastructure/runtime/python-runtime.js";
import { rgTool } from "./tools/rg.js";
import { webSearchTool } from "./tools/web-search.js";
import {
  isToolMountedForSession,
  profileCanUseTool,
} from "./tool-mount-policy.js";
import {
  taskCreateTool,
  taskUpdateTool,
  taskGetTool,
  taskListTool,
} from "./tools/task-tools.js";
import { browserTools } from "./tools/browser/browser-tools.js";
import { designTools } from "./design-tools.js";
import { conversationGitTools } from "./conversation-git/tools.js";
import { remotePrTools } from "../remote-pr/tools.js";
import { worktreeTools } from './tools/worktree.js';
import { sessionTools } from './tools/session.js';
import { formatToolInputError } from './validation/tool-input-error.js';

const SUMMARY_LIMIT = 1_000;

function summarize(value: unknown): string {
  if (typeof value === "string") return value.slice(0, SUMMARY_LIMIT);
  try {
    return JSON.stringify(value).slice(0, SUMMARY_LIMIT);
  } catch {
    return String(value).slice(0, SUMMARY_LIMIT);
  }
}

export interface ExecuteToolOptions {
  onProgress?: (record: ToolCallRecord) => void;
  /** Internal read-only composition: never suspend for approval. */
  codeModeParentId?: string;
  abortSignal?: AbortSignal;
  runId?: string | null;
  stepId?: string | null;
  modelToolCallId?: string | null;
  resumeToken?: string | null;
}

export interface ExecuteToolResult {
  record: ToolCallRecord;
  permission?: PermissionDecision;
  toolResult?: ToolExecutionResult;
  interactionId?: string;
}

export class ToolRegistry {
  readonly commandTasks: CommandTasks;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly hooks = new Map<string, ToolHook>();
  private readonly providers = new Map<string, SessionToolProvider>();

  readonly capabilities: NativeCapabilities;

  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly permissions: PermissionPolicy = permissionPolicy,
    private readonly events: AgentEventService = agentEventService,
    private readonly evidence: EvidenceService = evidenceService,
    private readonly profiles: ProfileService = profileService,
  ) {
    this.commandTasks = new CommandTasks(this.store);
    this.register(this.commandTasks.tool());
    [
      ...controlTools,
      ...subagentLifecycleTools,
      ...designTools,
      ...conversationGitTools,
      ...remotePrTools,
      ...worktreeTools,
      ...sessionTools,
      ...workTools,
      verificationTool,
      bashTool,
      runTool,
      fileReadTool,
      mediaReadTool,
      mediaGenerateTool,
      ...mediaAudioVideoTools,
      ...mediaJobsTools,
      fileListTool,
      rgTool,
      webSearchTool,
      diffReadTool,
      fileWriteTool,
      patchTool,
      fileDeleteTool,
      taskCreateTool,
      taskUpdateTool,
      taskGetTool,
      taskListTool,
      ...browserTools,
      INVALID_TOOL,
    ].forEach((tool) => this.register(tool));
    if (resolvePythonRuntime()) {
      this.register(fileGenerateTool);
      this.register(pythonRunTool);
    } else
      logger.warn("[agent-runtime] file.generate and python.run are unavailable: no bundled Python runtime or development python3 found.");
    for (const tool of createCodeTools(this, this.store, this.profiles)) this.register(tool);
    this.capabilities = new NativeCapabilities(this, this.store, this.profiles);
    for (const tool of this.capabilities.tools()) this.register(tool);
    this.registerProvider(mcpSessionToolProvider);
    this.registerProvider(jevSessionToolProvider);
    this.registerProvider(customToolProvider);
    this.register({
      id: "subagent.delegate", label: "Delegate to Subagent",
      description: "Delegate a focused task to a general-purpose subagent. Automatically configure its profile or use a user-selected templateId. The tool starts the child and waits for its result before the parent continues.",
      progressiveDetails: "Configure profile.name, description, instructions, capabilities, access, writeScope, skills, model and thinkingMode as needed. Omitted fields inherit the parent. profile.model takes an exact configured ref listed below; profile.thinkingMode is reasoning effort, never a model. Delegate automatically within current authorization; never ask the user to configure a role or approve an already-authorized delegation. Explicit parent restrictions still apply. Assign non-overlapping file ownership, preserve other agents' edits, and use subagent.lifecycle start for background work. Up to 5 active children; children cannot delegate.",
      category: "task", internalGate: "task", mutability: "task", resumeBehavior: "auto",
      inputSchema: delegateArgsSchema,
      execute: delegateSubagent,
    });
    this.register(presentationTool);
    this.register({
      id: "skill.load",
      label: "Load Skill",
      getPattern: (args) =>
        (args as { skillId?: string } | null)?.skillId ?? "skill.load",
      description:
        "Load full skill content after profile filtering and permission evaluation.",
      category: "skill",
      internalGate: "skill",
      mutability: "read",
      resumeBehavior: "auto",
      progressiveDetails:
        "Accepts { skillId: string } and returns full content only after the runtime gate. Use an exact skillId from the available-skills catalog, not a filesystem path or display name. Loading still checks availability, profile and permission rules.",
      inputSchema: z.object({
        skillId: z.string().min(1).describe("Skill id to load."),
      }),
      execute: (input) => {
        const session = this.store.getSession(input.sessionId);
        const profile = this.profiles.getForSession(session);
        const args = input.args as { skillId?: string };
        if (!args?.skillId) throw new Error("skillId is required.");
        const skill = skillAgentBridge.loadForTool({
          sessionId: input.sessionId,
          skillId: args.skillId,
          profileKind: profile.kind,
        });
        rememberLoadedSkill(input.sessionId, input.runId ?? null, skill);
        return {
          result: skill,
          displaySummary: `Loaded skill ${skill.id}.`,
          artifacts: [
            {
              kind: "decision",
              title: "Skill loaded",
              summary: `Loaded skill ${skill.id}.`,
              risk: "low",
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

  list(): Array<Omit<RegisteredTool, "execute">> {
    return [...this.tools.values()].map(
      ({ execute: _execute, ...summary }) => summary,
    );
  }

  /** List all tools available for a specific session, merging global tools
   *  with session-provider tools. Provider tools shadow global tools with the same ID.
   *  Execution gates (work state, plan mode) are applied unless `includeGated` is set,
   *  which capability listings use to keep showing mounted tools the runtime blocks. */
  listForSession(
    sessionId: string,
    options: { includeGated?: boolean } = {},
  ): Array<Omit<RegisteredTool, "execute">> {
    const sessionTools: Array<Omit<RegisteredTool, "execute">> = [];
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
    const session = this.store.getSession(sessionId);
    const effective = this.profiles.getForSession(session);
    return [...sessionTools, ...globalTools].filter(
      (t) =>
        extensionStore.active(session.projectId, "tool", t.id) &&
        // controlToolError includes mounting checks; inspect mounting alone
        // only when a caller explicitly asks to include gated tools.
        (options.includeGated
          ? isToolMountedForSession(session, t)
          : !controlToolError(session, t)) &&
        (!["specialist", "subagent", "git-merge-worker"].includes(session.profileId) ||
          profileCanUseTool(effective, t) ||
          t.id === INVALID_TOOL_ID),
    );
  }

  get(toolId: string): RegisteredTool {
    const direct = this.tools.get(toolId);
    if (direct) return direct;
    const resolvedId = this.resolveToolId(toolId, [...this.tools.keys()]);
    return this.tools.get(resolvedId)!;
  }

  /** Look up a tool by ID, checking session providers first, then global registry. */
  getForSession(sessionId: string, toolId: string): RegisteredTool {
    const session = this.store.getSession(sessionId);
    const direct = this.lookupForSession(sessionId, toolId);
    if (direct) return this.assertEnabled(session.projectId, direct);
    // Slow path only: a model or provider emitted a variant of a real name.
    // Aggregating every provider contract on the hot path would make ordinary
    // calls pay for this diagnostic.
    const resolvedId = this.resolveToolId(toolId, [
      ...[...this.providers.values()].flatMap((provider) =>
        provider.getTools(sessionId).map((tool) => tool.id),
      ),
      ...this.tools.keys(),
    ]);
    return this.assertEnabled(
      session.projectId,
      this.lookupForSession(sessionId, resolvedId)!,
    );
  }

  private lookupForSession(
    sessionId: string,
    toolId: string,
  ): RegisteredTool | undefined {
    for (const provider of this.providers.values()) {
      const found = provider
        .getTools(sessionId)
        .find((tool) => tool.id === toolId);
      if (found) return found;
    }
    return this.tools.get(toolId);
  }

  private assertEnabled(projectId: string, tool: RegisteredTool): RegisteredTool {
    if (!extensionStore.active(projectId, "tool", tool.id)) throw new AgentPermissionError(`Tool ${tool.id} has been removed or disabled in this project.`);
    return tool;
  }

  /** Accept the variants a model or provider produces for the same tool:
   * provider-safe spellings, namespace prefixes, wire hashes and the small
   * compatibility vocabulary. Ambiguous names stay unresolved so a different
   * tool is never executed on a guess. */
  private resolveToolId(toolId: string, availableIds: string[]): string {
    const resolution = resolveToolName(toolId, availableIds);
    if (!resolution.match)
      throw new AgentToolNotFoundError(toolId, resolution.suggestions);
    logger.debug(
      {
        requested: toolId,
        resolved: resolution.match.toolId,
        basis: resolution.match.basis,
      },
      "[agent-runtime] resolved tool name variant",
    );
    return resolution.match.toolId;
  }

  async resumePending(
    sessionId: string,
    permission: PermissionDecision,
    abortSignal?: AbortSignal,
    onProgress?: (record: ToolCallRecord) => void,
  ): Promise<ExecuteToolResult> {
    await businessStore.refresh();
    await hydrateRuntimeAssets([sessionId]);
    if (permission.action !== "allow") {
      throw new AgentValidationError(
        "Only approved permission requests can be resumed.",
      );
    }
    if (!permission.toolCallId) {
      throw new AgentValidationError(
        "Permission resume requires a persisted tool call.",
      );
    }
    const record = this.store.getToolCall(sessionId, permission.toolCallId);
    if (record.status !== "pending") {
      return { record, permission };
    }
    let tool: RegisteredTool;
    try {
      tool = this.getForSession(sessionId, record.toolId);
    } catch (error) {
      if (!isToolResolutionError(error)) throw error;
      return { ...this.rejectToolCall(sessionId, record.toolId, record.inputRef, {}, error, { existing: record }), permission };
    }
    return this.performExecution(
      sessionId,
      tool,
      record,
      record.inputRef,
      permission,
      abortSignal,
      onProgress,
    );
  }

  async execute(
    sessionId: string,
    toolId: string,
    args: unknown,
    options: ExecuteToolOptions = {},
  ): Promise<ExecuteToolResult> {
    await businessStore.refresh();
    await hydrateRuntimeAssets([sessionId]);
    const session = this.store.getSession(sessionId);
    const profile = this.profiles.getForSession(session);
    let tool: RegisteredTool;
    try {
      tool = this.getForSession(sessionId, toolId);
    } catch (error) {
      if (!isToolResolutionError(error)) throw error;
      return this.rejectToolCall(sessionId, toolId, args, options, error);
    }
    // Resolve an in-memory script reference before creating the permission
    // decision. The approval receipt must bind the exact immutable source that
    // will execute; the cache itself never carries authorization.
    if (tool.id === "run") {
      let resolved: ReturnType<typeof prepareRunArgs>;
      try {
        resolved = prepareRunArgs(sessionId, args);
      } catch (error) {
        // Pre-approval validation/cache misses are tool failures, not failed
        // turns. Keep the original input and provider identity in the receipt.
        const message = formatToolInputError(tool.id, args, error) ??
          (error instanceof Error ? error.message : String(error));
        return this.rejectToolCall(sessionId, tool.id, args, options,
          new AgentValidationError(message), { tool });
      }
      // Persist/forward the resolved source as a valid public invocation shape;
      // keeping both scriptId and source would fail the exactly-one schema when
      // an approval is resumed. The permission metadata already binds this
      // immutable source snapshot.
      if (resolved.scriptId) {
        const { scriptId: _scriptId, ...sourceArgs } = resolved;
        args = sourceArgs;
      } else {
        args = resolved;
      }
    }

    this.capabilities.noteUse(sessionId, tool.id);
    const strictSubagentProfile = session.profileId === "git-merge-worker";
    const controlError = options.codeModeParentId && (!canComposeTool(session, tool) || !profileCanUseTool(profile, tool))
      ? "Tool is no longer approved for Code Mode."
      : this.commandTasks.toolError(options.runId, tool.id) ?? controlToolError(session, tool, args);
    if (
      controlError ||
      (strictSubagentProfile && !profileCanUseTool(profile, tool) && tool.id !== INVALID_TOOL_ID) ||
      (!strictSubagentProfile && !profileCanUseTool(profile, tool) &&
        tool.category !== "skill" &&
        tool.category !== "mcp" &&
        tool.id !== INVALID_TOOL_ID &&
        !["work.checkpoint", "context.read"].includes(tool.id) &&
        !(
          tool.id === "verification.run" &&
          profileCanUseTool(profile, { id: "bash" })
        ))
    ) {
      const errorMsg =
        controlError ??
        `Tool ${tool.id} is not available to profile ${profile.id}. Use only the tools listed in your capabilities.`;
      const now = nowIso();
      const record = this.store.appendToolCall({
        id: makeRuntimeId("tc"),
        sessionId,
        runId: options.runId ?? null,
        stepId: options.stepId ?? null,
        modelToolCallId: options.modelToolCallId ?? null,
        toolId: tool.id,
        category: tool.category,
        mutability: tool.mutability,
        argsHash: this.store.hashArgs(args),
        inputSummary: summarize(args),
        inputRef: args ?? null,
        outputSummary: errorMsg,
        outputRef: { error: true, message: errorMsg },
        status: controlError ? "denied" : "failed",
        permissionDecisionId: null,
        startedAt: now,
        endedAt: now,
        error: errorMsg,
      });
      return {
        record,
        toolResult: {
          result: { error: true, message: errorMsg },
          displaySummary: errorMsg,
          artifacts: [],
        },
      };
    }

    const now = nowIso();
    const record = this.store.appendToolCall({
      id: makeRuntimeId("tc"),
      sessionId,
      runId: options.runId ?? null,
      stepId: options.stepId ?? null,
      modelToolCallId: options.modelToolCallId ?? null,
      toolId: tool.id,
      category: tool.category,
      mutability: tool.mutability,
      argsHash: this.store.hashArgs(args),
      inputSummary: summarize(args),
      inputRef: args ?? null,
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt: now,
      endedAt: null,
      error: null,
    });
    this.events.append({
      sessionId,
      type: "tool_call",
      summary: `Tool ${tool.id} started`,
      payload: {
        runId: options.runId ?? null,
        stepId: options.stepId ?? null,
        toolCallId: record.id,
        toolId: tool.id,
        category: tool.category,
        mutability: tool.mutability,
        ...(codeParentId(record) ? { parentToolCallId: codeParentId(record) } : {}),
      },
    });
    // Delegation records must be visible before their child is awaited. Keep
    // this fast path limited to the two delegation tools: ordinary tool calls
    // retain their existing stream timing, so this fix adds no per-tool IPC or
    // live-bus traffic. The later stream/tool-result update reuses the record
    // id, so the client upserts rather than renders a second row.
    if (tool.id === "subagent.delegate" || tool.id === "subagent.lifecycle")
      emitSessionLive(sessionId, {
        type: "tool_call",
        stepId: record.stepId ?? "",
        toolCall: record,
      });

    const bashCommand =
      (tool.id === "bash" || tool.id === "verification.run") &&
      typeof args === "object" &&
      args &&
      "command" in args &&
      typeof (args as { command?: unknown }).command === "string"
        ? (args as { command: string }).command
        : null;
    const runArgv =
      tool.id === "run" && typeof args === "object" && args &&
      Array.isArray((args as { argv?: unknown }).argv)
        ? (args as { argv: string[] }).argv
        : null;

    const decision = bashCommand
      ? this.permissions.evaluateShellCommand({
          sessionId,
          runId: options.runId ?? null,
          stepId: options.stepId ?? null,
          toolCallId: record.id,
          category: tool.category,
          internalGate: tool.internalGate ?? "none",
          rules: session.permissionRules,
          isSubSession: Boolean(session.parentSessionId),
          resumeToken: options.resumeToken ?? null,
          command: bashCommand,
          metadata: {
            toolId: tool.id,
            args,
            mutability: tool.mutability,
          },
        })
      : runArgv
        ? this.permissions.evaluateArgvCommand({
            sessionId,
            runId: options.runId ?? null,
            stepId: options.stepId ?? null,
            toolCallId: record.id,
            category: tool.category,
            internalGate: tool.internalGate ?? "none",
            rules: session.permissionRules,
            isSubSession: Boolean(session.parentSessionId),
            resumeToken: options.resumeToken ?? null,
            argv: runArgv,
            metadata: {
              toolId: tool.id,
              args,
              mutability: tool.mutability,
            },
          })
      : this.permissions.evaluate({
          sessionId,
          runId: options.runId ?? null,
          stepId: options.stepId ?? null,
          toolCallId: record.id,
          category: tool.category,
          internalGate: tool.internalGate ?? "none",
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
    this.store.updateToolCall(sessionId, record.id, {
      permissionDecisionId: decision.id,
    });

    if (decision.action === "ask" && options.codeModeParentId) {
      const reason = "Code Mode cannot wait for approval. Invoke this tool directly to request permission.";
      const denied = this.store.updatePermission(sessionId, decision.id, { action: "deny", resolvedAt: nowIso(), reason });
      const recordDenied = this.store.updateToolCall(sessionId, record.id, { status: "denied", error: reason, outputSummary: reason, endedAt: nowIso() });
      this.events.append({ sessionId, type: "tool_result", summary: reason, payload: {
        runId: record.runId, stepId: record.stepId, toolCallId: record.id,
        parentToolCallId: options.codeModeParentId, status: "denied",
      } });
      return { record: recordDenied, permission: denied };
    }
    // An interactive side chat is a user-facing conversation with the primary
    // session's permissions, so the user approves here exactly as they do in
    // the primary rail. Delegated children never open their own dialog.
    if (decision.action === "ask" && ["specialist", "subagent"].includes(session.profileId) && !isInteractiveSideChat(session)) {
      const reason =
        "This operation needs user approval. Return the permission blocker to the primary agent; specialists never open their own approval dialog.";
      const denied = this.store.updatePermission(sessionId, decision.id, {
        action: "deny",
        resolvedAt: nowIso(),
        reason,
      });
      return {
        record: this.store.updateToolCall(sessionId, record.id, {
          status: "denied",
          error: reason,
          outputSummary: reason,
          endedAt: nowIso(),
        }),
        permission: denied,
      };
    }
    if (decision.action === "ask") {
      this.store.updateSession(sessionId, {
        status: "waiting_permission",
        updatedAt: nowIso(),
        pendingResumeToken: decision.resumeToken,
      });
      this.events.append({
        sessionId,
        type: "permission_requested",
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
        record: this.store.updateToolCall(sessionId, record.id, {
          status: "pending",
        }),
        permission: decision,
      };
    }

    if (decision.action === "deny") {
      this.events.append({
        sessionId,
        type: "permission_resolved",
        summary: decision.reason,
        payload: {
          permissionId: decision.id,
          action: "deny",
          toolCallId: record.id,
        },
      });
      return {
        record: this.store.updateToolCall(sessionId, record.id, {
          status: "denied",
          endedAt: nowIso(),
          error: decision.reason,
        }),
        permission: decision,
      };
    }

    return this.performExecution(
      sessionId,
      tool,
      record,
      args,
      decision,
      options.abortSignal,
      options.onProgress,
    );
  }

  /** Persist a terminal receipt before replying to the model. In particular,
   * a resumed approval updates its existing receipt so recovery cannot replay it. */
  private rejectToolCall(
    sessionId: string,
    toolId: string,
    args: unknown,
    options: ExecuteToolOptions,
    error: AgentToolNotFoundError | AgentPermissionError | AgentValidationError,
    { existing, tool }: { existing?: ToolCallRecord; tool?: RegisteredTool } = {},
  ): ExecuteToolResult {
    const now = nowIso();
    const result = { error: true, code: error.code, message: error.message };
    const patch = {
      status: error instanceof AgentPermissionError ? "denied" as const : "failed" as const,
      outputSummary: error.message,
      outputRef: result,
      endedAt: now,
      error: error.message,
    };
    const record = existing
      ? this.store.updateToolCall(sessionId, existing.id, patch)
      : this.store.appendToolCall({
          id: makeRuntimeId("tc"), sessionId,
          runId: options.runId ?? null, stepId: options.stepId ?? null,
          modelToolCallId: options.modelToolCallId ?? null,
          toolId, category: tool?.category ?? "context", mutability: tool?.mutability ?? "read",
          argsHash: this.store.hashArgs(args), inputSummary: summarize(args), inputRef: args ?? null,
          permissionDecisionId: null, startedAt: now, ...patch,
        });
    this.events.append({
      sessionId, type: "tool_result", summary: error.message,
      payload: {
        runId: record.runId, stepId: record.stepId, toolCallId: record.id,
        toolId, status: record.status, code: error.code, error: error.message,
        ...(codeParentId(record) ? { parentToolCallId: codeParentId(record) } : {}),
      },
    });
    // Keep identifiers for diagnosis without logging arguments or file contents.
    logger.warn({ sessionId, runId: record.runId, stepId: record.stepId,
      toolCallId: record.id, modelToolCallId: record.modelToolCallId, toolId, code: error.code,
    }, "[agent-runtime] tool call rejected before execution; returning error to model");
    return { record, toolResult: { outcome: patch.status, result, displaySummary: error.message, artifacts: [] } };
  }

  private async performExecution(
    sessionId: string,
    tool: RegisteredTool,
    record: ToolCallRecord,
    args: unknown,
    permission?: PermissionDecision,
    abortSignal?: AbortSignal,
    onProgress?: (record: ToolCallRecord) => void,
  ): Promise<ExecuteToolResult> {
    if (codeParentId(record)) return this.performOwnedExecution(sessionId, tool, record, args, permission, abortSignal, onProgress);
    return this.commandTasks.execute(record, args, abortSignal, (signal, started) =>
      this.performOwnedExecution(sessionId, tool, record, args, permission, signal, onProgress, started), onProgress);
  }

  private async performOwnedExecution(
    sessionId: string,
    tool: RegisteredTool,
    record: ToolCallRecord,
    args: unknown,
    permission?: PermissionDecision,
    abortSignal?: AbortSignal,
    onProgress?: (record: ToolCallRecord) => void,
    onExecutionStarted?: () => void,
  ): Promise<ExecuteToolResult> {
    const executionStarted = performance.now();
    const timings: Record<string, number> = {};
    try {
      await businessStore.refresh();
      await hydrateRuntimeAssets([sessionId]);
      abortSignal?.throwIfAborted();
      const freshSession = this.store.getSession(sessionId);
      const policyError = controlToolError(freshSession, tool, args);
      if (policyError) throw new AgentValidationError(policyError);
      assertSpecialistToolAllowed(freshSession, tool.id, args);
      assertSubagentToolAllowed(freshSession, tool, args, Boolean(permission?.userReply));
      if (
        freshSession.profileId === "specialist" &&
        freshSession.parentSessionId
      ) {
        const parent = this.store.getSession(freshSession.parentSessionId);
        const decision = resolvePermissionDecision({
          sessionId: parent.id,
          category: tool.category,
          internalGate: tool.internalGate,
          pattern: tool.getPattern?.(args) ?? tool.id,
          rules: parent.permissionRules,
        });
        if (
          decision.action === "deny" ||
          (decision.action === "ask" && !permission?.userReply)
        )
          throw new AgentValidationError(
            "Parent permissions no longer authorize this specialist operation.",
          );
        if (
          tool.id === "skill.load" &&
          !parent.skillIds.includes((args as { skillId: string }).skillId)
        )
          throw new AgentValidationError(
            "The skill is no longer assigned to the parent.",
          );
      }
      if (
        tool.mutability === "write" ||
        tool.id === "bash" ||
        tool.id === "run" ||
        tool.id === "verification.run" ||
        tool.id === "python.run" ||
        tool.category === "mcp"
      ) {
        const rootId = freshSession.parentSessionId ?? freshSession.id;
        const root = this.store.getSession(rootId);
        if (
          freshSession.profileId === "specialist" &&
          resolvePermissionDecision({
            sessionId: rootId,
            category: tool.category,
            internalGate: tool.internalGate,
            pattern: tool.getPattern?.(args) ?? tool.id,
            rules: root.permissionRules,
          }).action !== "allow"
        )
          throw new AgentValidationError(
            "Parent no longer grants this write operation.",
          );
        const childControl = readSubagentControl(freshSession);
        const releasedChild = childControl?.joinMode === "async" && !childControl.terminal &&
          childControl.parentSessionId === root.id && childControl.childSessionId === freshSession.id &&
          root.status === "completed" && !root.sessionMetadata?.manualStop && !root.sessionMetadata?.runtimeControl;
        // A side chat is a user-facing conversation: the user drives it, so the
        // primary run state must not gate its tools. Delegated children are
        // suspended once their parent stops.
        if (freshSession.parentSessionId && !isInteractiveSideChat(freshSession) && root.status !== "running" && !releasedChild)
          throw new AgentValidationError(
            "Parent is not running; child writes are suspended.",
          );
        const otherWriter = root.childSessionIds
          .map((id) => this.store.tryGetSession(id))
          .find(
            (s) =>
              s &&
              s.id !== sessionId &&
              ["running", "waiting_permission", "waiting_input"].includes(
                s.status,
              ) &&
              (
                s.sessionMetadata?.specialist as
                  | { writeScope?: string[] }
                  | undefined
              )?.writeScope?.length,
          );
        if (otherWriter)
          throw new AgentValidationError(
            "Another specialist owns the workspace write slot.",
          );
      }
      if (tool.inputSchema) {
        try {
          args = tool.inputSchema.parse(args ?? {});
        } catch (error) {
          const diagnostic = formatToolInputError(tool.id, args, error);
          if (diagnostic) throw new AgentValidationError(diagnostic);
          throw error;
        }
      }
      const running =
        record.status === "running"
          ? record
          : this.store.updateToolCall(sessionId, record.id, {
              status: "running",
              endedAt: null,
              error: null,
              outputSummary: null,
              outputRef: null,
            });
      let lastProgress = 0;
      const report = (execution: NonNullable<ToolCallRecord["execution"]>) => {
        const previous = this.store.getToolCall(sessionId, running.id).execution;
        const updated = this.store.updateToolCall(sessionId, running.id, { execution: { ...previous, ...execution } });
        onProgress?.(updated);
      };
      const input: ToolExecutionInput = {
        onCommandStarted: () => {
          timings.commandStartedMs = Math.round(performance.now() - executionStarted);
          onExecutionStarted?.();
        },
        onProgress: progress => {
          if (Date.now() - lastProgress < 1_000) return;
          lastProgress = Date.now();
          const current = this.store.getToolCall(sessionId, running.id).execution;
          report({ ...current, phase: "executing_tool", ...progress, lastProgressAt: nowIso() });
        },
        abortSignal,
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
      const hookCtx: ToolHookContext = {
        sessionId,
        runId: running.runId,
        stepId: running.stepId,
        toolCallId: running.id,
        toolId: running.toolId,
        args,
        result: null!,
      };
      void sessionHooks.emit({ type: "tool:before", ctx: hookCtx });
      const approvalPaths = permission?.metadata?.approvalPaths;
      const approved =
        permission?.action === "allow" &&
        permission.sessionId === sessionId &&
        permission.toolCallId === running.id &&
        Array.isArray(approvalPaths);
      const projectGrant = permission?.metadata?.projectToolGrant === true ||
        permission?.userReply === "always" && permission.metadata?.toolId === tool.id;
      const inApprovalScope = <T>(action: () => T): T =>
        projectGrant
          ? withProjectToolApproval(sessionId, tool.id, action)
          : approved
          ? withSandboxApproval(
              sessionId,
              approvalPaths.filter(
                (value): value is string => typeof value === "string",
              ),
              action,
            )
          : action();
      const assertGrantCurrent = () => {
        if (!projectGrant) return;
        if (!hasProjectToolGrant(sessionId, tool.id))
          throw new AgentPermissionError("Project-wide tool approval has been revoked.");
        const current = this.store.getSession(sessionId);
        if (isProjectToolGrantDenied({
          sessionId,
          category: tool.category,
          internalGate: tool.internalGate,
          pattern: tool.getPattern?.(args) ?? tool.patterns?.[0] ?? tool.id,
          isSubSession: Boolean(current.parentSessionId),
          rules: current.permissionRules,
          // Reuse the initial run argv/script risk checks, not only getPattern.
          metadata: { toolId: tool.id, args, mutability: tool.mutability },
        }, (tool.id === "bash" || tool.id === "verification.run")
          ? (args as { command?: string }).command : undefined))
          throw new AgentPermissionError("An explicit permission restriction denies this tool.");
      };
      assertGrantCurrent();
      inApprovalScope(() =>
        sandboxPolicy.validateToolArgs(
          running.toolId,
          args,
          workspaceRoot(sessionId),
          sessionId,
        ),
      );
      const trackChanges =
        tool.mutability === "write" ||
        (tool.id === "bash" && !bashUsesInspectionCapacity((args as { command: string }).command)) ||
        tool.id === "run" ||
        tool.id === "verification.run" ||
        tool.id === "python.run" ||
        (tool.category === "mcp" && !tool.codeModeReadOnly && !codeParentId(record));
      abortSignal?.throwIfAborted();
      await assertRuntimeExecutionCurrent();
      assertHistoryUnlocked(sessionId);
      const checkpointMutation =
        tool.mutability === "write" ||
        tool.id === "bash" ||
        tool.id === "run" ||
        tool.id === "verification.run" ||
        tool.id === "python.run" ||
        (tool.category === "mcp" && !codeParentId(record));
      const executeTool = async () => {
        await businessStore.refresh(['tool-grants','extension-state']);
        // Acquiring the write lease may yield. Recheck cancellation and
        // ownership immediately before the native tool is allowed to write.
        if (!extensionStore.active(this.store.getSession(sessionId).projectId, "tool", tool.id)) throw new AgentPermissionError(`Tool ${tool.id} has been removed or disabled.`);
        abortSignal?.throwIfAborted();
        await assertRuntimeExecutionCurrent();
        assertHistoryUnlocked(sessionId);
        assertGrantCurrent();
        await businessStore.flush();
        // Opaque commands may change files, including before failing. Record
        // that uncertainty once; verification/acceptance owns content scans.
        if (trackChanges) workRuntime.markWorkspaceDirty(sessionId);
        const result = inApprovalScope(() => withCommandSignal(abortSignal, () => tool.execute(input)));
        // Only reads may abandon their local wait. A writer retains its claim
        // until the underlying operation settles, even after cancellation.
        return codeParentId(record) && !checkpointMutation && !currentExecutionContext()
          ? waitForCodeRead(result, abortSignal)
          : result;
      };
      let undoPaths: string[] | undefined;
      if (
        ["file.write", "file.delete"].includes(tool.id) &&
        typeof (args as { path?: unknown }).path === "string"
      )
        undoPaths = [
          inApprovalScope(() => resolveUndoPath((args as { path: string }).path, sessionId)),
        ];
      if (tool.id === "file.patch")
        undoPaths = parseApplyPatchEnvelope((args as { patch: string }).patch)
          .flatMap((hunk) => [
            hunk.path,
            ...("movePath" in hunk && hunk.movePath ? [hunk.movePath] : []),
          ])
          .map((file) => inApprovalScope(() => resolveUndoPath(file, sessionId)));
      const admissionStarted = performance.now();
      const result = await withToolResource(tool, input, report, async toolSignal => {
        timings.admissionMs = Math.round(performance.now() - admissionStarted);
        input.abortSignal = toolSignal;
        abortSignal = toolSignal;
        return checkpointMutation
          ? withWorkspaceMutation(sessionId, executeTool, false, undoPaths, toolSignal)
          : executeTool();
      });
      timings.resourceMs = Math.round(performance.now() - admissionStarted);
      abortSignal?.throwIfAborted();
      if (result.suspend) {
        const work = workStore.current(sessionId);
        if (work) {
          work.status = "waiting";
          work.reason = "awaiting_input";
          workStore.save(work);
        }
        return {
          record: this.store.getToolCall(sessionId, running.id),
          interactionId: result.suspend.interactionId,
        };
      }
      const outputSummary = result.displaySummary.slice(0, SUMMARY_LIMIT);
      const status = result.outcome ?? (result.displaySummary.length > SUMMARY_LIMIT ? "compacted" : "completed");

      for (const artifact of result.artifacts) {
        this.evidence.append({
          sessionId,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
          sourceRefs: [{ type: "tool_call", id: running.id }],
          risk: artifact.risk ?? "unknown",
          metadata: artifact.metadata,
        });
      }

      const completed = this.store.updateToolCall(sessionId, running.id, {
        status,
        outputSummary,
        outputRef: result.result ?? null,
        error: result.outcome === "failed" || result.outcome === "denied" ? outputSummary : null,
        contentParts: result.contentParts,
        endedAt: nowIso(),
      });

      workRuntime.recordTool(completed);

      // A write tool just touched the working tree; drop the cached
      // environment snapshot so the UI's next poll reflects the new diff
      // instead of waiting out the cache TTL.
      if (tool.mutability === "write" || tool.id === "python.run" || tool.id === "run") invalidateSessionEnvironment(sessionId);

      await this.fireHooks({
        sessionId,
        runId: running.runId,
        stepId: running.stepId,
        toolCallId: running.id,
        toolId: running.toolId,
        args,
        result,
      });
      void sessionHooks.emit({
        type: "tool:after",
        ctx: {
          sessionId,
          runId: running.runId,
          stepId: running.stepId,
          toolCallId: running.id,
          toolId: running.toolId,
          args,
          result,
        },
      });

      this.events.append({
        sessionId,
        type: "tool_result",
        summary: `${tool.id}: ${outputSummary}`,
        payload: {
          runId: completed.runId,
          stepId: completed.stepId,
          toolCallId: completed.id,
          ...(codeParentId(completed) ? { parentToolCallId: codeParentId(completed) } : {}),
          status,
          followUpHints: result.followUpHints ?? [],
        },
      });
      return { record: completed, permission, toolResult: result };
    } catch (error) {
      if (isExecutionSuperseded(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = error instanceof PatchApplyError ? error.diagnostic : undefined;
      // Excerpts belong in the durable tool receipt, never in event summaries.
      const failureSummary = diagnostic ? `${tool.id} failed: ${diagnostic.code}` : `${tool.id} failed: ${message}`;
      const failed = this.store.updateToolCall(sessionId, record.id, {
        status: error instanceof AgentPermissionError ? "denied" : "failed",
        endedAt: nowIso(),
        error: message,
        ...(diagnostic ? { outputRef: diagnostic, outputSummary: failureSummary } : {}),
      });
      // A failed tool call is a SIGNAL, not a session death sentence. The failure
      // is surfaced to the model as a tool_result so it can self-correct (change
      // approach, fix args, switch tools). Consecutive same-tool failures trigger
      // a corrective system-reminder (see buildConsecutiveFailureReminder), and
      // genuine no-progress loops are caught by detectDoomLoop. We deliberately do
      // NOT block the session on a failure count.
      this.events.append({
        sessionId,
        type: "tool_result",
        summary: failureSummary,
        payload: {
          runId: failed.runId,
          stepId: failed.stepId,
          toolCallId: failed.id,
          ...(codeParentId(failed) ? { parentToolCallId: codeParentId(failed) } : {}),
          status: failed.status,
          ...(diagnostic ? {
            toolId: tool.id,
            code: diagnostic.code,
            applied: diagnostic.applied,
            ...(diagnostic.hunkIndex !== undefined ? { hunkIndex: diagnostic.hunkIndex } : {}),
            ...(diagnostic.patchLine !== undefined ? { patchLine: diagnostic.patchLine } : {}),
            ...(diagnostic.searchStartLine !== undefined ? { searchStartLine: diagnostic.searchStartLine } : {}),
            ...(diagnostic.readBaseline !== undefined ? { readBaseline: diagnostic.readBaseline } : {}),
          } : { error: message }),
        },
      });
      return {
        record: failed,
        permission,
        ...(diagnostic ? { toolResult: {
          outcome: "failed" as const,
          result: diagnostic,
          displaySummary: failureSummary,
          artifacts: [],
        } } : {}),
      };
    } finally {
      if (tool.id === "bash" || tool.id === "verification.run") logger.info({
        event: "tool.execution.timing", sessionId, runId: record.runId, toolCallId: record.id,
        toolId: tool.id, timings, totalMs: Math.round(performance.now() - executionStarted),
      }, "Tool execution timing");
    }
  }

  private async fireHooks(ctx: ToolHookContext): Promise<void> {
    // Collect hooks from both session providers and global registry
    const allHooks: ToolHook[] = [...this.hooks.values()];
    for (const provider of this.providers.values()) {
      allHooks.push(...provider.getHooks(ctx.sessionId));
    }
    for (const hook of allHooks) {
      if (hook.toolId !== "*" && hook.toolId !== ctx.toolId) continue;
      try {
        await hook.afterExecute(ctx);
      } catch (err) {
        logger.warn(
          { hookId: hook.id, toolId: ctx.toolId, err },
          "[tool-registry] hook afterExecute failed",
        );
      }
    }
  }
}

export const toolRegistry = new ToolRegistry();
