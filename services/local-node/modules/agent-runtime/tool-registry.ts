import { withToolResource } from "./resource-admission.js";
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
import { workspaceFingerprint } from "./work-fingerprint.js";
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
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { mcpSessionToolProvider } from "../../infrastructure/mcp/mcp-session-tool-provider.js";
import { jevSessionToolProvider } from "../computer-use/jev-tool-provider.js";
import { INVALID_TOOL, INVALID_TOOL_ID } from "./tool-invalid.js";
import { diffReadTool } from "./tools/diff-read.js";
import { fileListTool } from "./tools/file-list.js";
import { patchTool } from "./tools/patch.js";
import { bashTool } from "./tools/bash.js";
import { fileReadTool } from "./tools/file-read.js";
import { fileDeleteTool } from "./tools/file-delete.js";
import { fileWriteTool } from "./tools/file-write.js";
import { fileGenerateTool } from "./tools/file-generate.js";
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
    [
      ...controlTools,
      ...subagentLifecycleTools,
      ...designTools,
      ...conversationGitTools,
      ...remotePrTools,
      ...worktreeTools,
      ...workTools,
      verificationTool,
      bashTool,
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
    if (resolvePythonRuntime()) this.register(fileGenerateTool);
    else logger.warn("[agent-runtime] file.generate is unavailable: no bundled Python runtime or development python3 found.");
    for (const tool of createCodeTools(this, this.store, this.profiles)) this.register(tool);
    this.capabilities = new NativeCapabilities(this, this.store, this.profiles);
    for (const tool of this.capabilities.tools()) this.register(tool);
    this.registerProvider(mcpSessionToolProvider);
    this.registerProvider(jevSessionToolProvider);
    this.registerProvider(customToolProvider);
    this.register({
      id: "subagent.delegate", label: "Delegate to Subagent",
      description: "Delegate a focused task to a general-purpose subagent. Automatically configure its profile or use a user-selected templateId. The tool starts the child and waits for its result before the parent continues.",
      progressiveDetails: "Configure profile.name, description, instructions, capabilities, access, writeScope, skills, model and thinkingMode as needed. Omitted fields inherit the parent. Delegate automatically within current authorization; never ask the user to configure a role or approve an already-authorized delegation. Explicit parent restrictions still apply. Assign non-overlapping file ownership, preserve other agents' edits, and use subagent.lifecycle start for background work. Up to 5 active children; children cannot delegate.",
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
    const tool = this.tools.get(toolId);
    if (!tool) throw new AgentToolNotFoundError(toolId);
    return tool;
  }

  /** Look up a tool by ID, checking session providers first, then global registry. */
  getForSession(sessionId: string, toolId: string): RegisteredTool {
    const session = this.store.getSession(sessionId);
    if (!extensionStore.active(session.projectId, "tool", toolId)) throw new AgentPermissionError(`Tool ${toolId} has been removed or disabled in this project.`);
    for (const provider of this.providers.values()) {
      const tools = provider.getTools(sessionId);
      const found = tools.find((t) => t.id === toolId);
      if (found) return found;
    }
    return this.get(toolId);
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
      return { ...this.rejectUnresolvedTool(sessionId, record.toolId, record.inputRef, {}, error, record), permission };
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
      return this.rejectUnresolvedTool(sessionId, toolId, args, options, error);
    }

    this.capabilities.noteUse(sessionId, toolId);
    const strictSubagentProfile = session.profileId === "git-merge-worker";
    const controlError = options.codeModeParentId && (!canComposeTool(session, tool) || !profileCanUseTool(profile, tool))
      ? "Tool is no longer approved for Code Mode."
      : controlToolError(session, tool, args);
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
        toolId,
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
      toolId,
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

    const bashCommand =
      (tool.id === "bash" || tool.id === "verification.run") &&
      typeof args === "object" &&
      args &&
      "command" in args &&
      typeof (args as { command?: unknown }).command === "string"
        ? (args as { command: string }).command
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
    if (decision.action === "ask" && ["specialist", "subagent"].includes(session.profileId)) {
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
  private rejectUnresolvedTool(
    sessionId: string,
    toolId: string,
    args: unknown,
    options: ExecuteToolOptions,
    error: AgentToolNotFoundError | AgentPermissionError,
    existing?: ToolCallRecord,
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
          toolId, category: "context", mutability: "read",
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
    }, "[agent-runtime] tool resolution rejected; returning error to model");
    return { record, toolResult: { result, displaySummary: error.message, artifacts: [] } };
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
    await businessStore.refresh();
    await hydrateRuntimeAssets([sessionId]);
    try {
      abortSignal?.throwIfAborted();
      const freshSession = this.store.getSession(sessionId);
      const policyError = controlToolError(freshSession, tool, args);
      if (policyError) throw new AgentValidationError(policyError);
      assertSpecialistToolAllowed(freshSession, tool.id, args);
      assertSubagentToolAllowed(freshSession, tool, args);
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
        tool.id === "verification.run" ||
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
        if (freshSession.parentSessionId && root.status !== "running" && !releasedChild)
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
      args = tool.inputSchema ? tool.inputSchema.parse(args ?? {}) : args;
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
        workStore.current(sessionId) &&
        (tool.mutability === "write" ||
          tool.id === "bash" ||
          tool.id === "verification.run" ||
          (tool.category === "mcp" && !codeParentId(record)));
      const fingerprintScope =
        typeof (args as { path?: unknown })?.path === "string"
          ? [(args as { path: string }).path]
          : ["."];
      const before = trackChanges
        ? await workspaceFingerprint(sessionId, fingerprintScope).catch(
            () => undefined,
          )
        : undefined;
      abortSignal?.throwIfAborted();
      await assertRuntimeExecutionCurrent();
      assertHistoryUnlocked(sessionId);
      const checkpointMutation =
        tool.mutability === "write" ||
        tool.id === "bash" ||
        tool.id === "verification.run" ||
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
      const result = await withToolResource(tool, input, report, async toolSignal => {
        input.abortSignal = toolSignal;
        abortSignal = toolSignal;
        return checkpointMutation
          ? withWorkspaceMutation(sessionId, executeTool, false, undoPaths, toolSignal)
          : executeTool();
      });
      const after = trackChanges
        ? await workspaceFingerprint(sessionId, fingerprintScope).catch(
            () => undefined,
          )
        : undefined;
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
        error: result.outcome ? outputSummary : null,
        contentParts: result.contentParts,
        endedAt: nowIso(),
      });

      workRuntime.recordTool(completed, before, after);
      if (trackChanges && (!before || !after)) {
        const work = workStore.current(sessionId);
        if (work && !["completed", "cancelled"].includes(work.status)) {
          work.hasChanges = true;
          work.changeVersion++;
          workStore.save(work);
        }
      }

      // A write tool just touched the working tree; drop the cached
      // environment snapshot so the UI's next poll reflects the new diff
      // instead of waiting out the cache TTL.
      if (tool.mutability === "write") invalidateSessionEnvironment(sessionId);

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
      const work = workStore.current(sessionId);
      if (
        work &&
        !["completed", "cancelled"].includes(work.status) &&
        (tool.mutability === "write" ||
          tool.id === "bash" ||
          tool.id === "verification.run" ||
          (tool.category === "mcp" && !codeParentId(record)))
      ) {
        work.hasChanges = true;
        work.changeVersion++;
        workStore.save(work);
      }
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.store.updateToolCall(sessionId, record.id, {
        status: error instanceof AgentPermissionError ? "denied" : "failed",
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
        type: "tool_result",
        summary: `${tool.id} failed: ${message}`,
        payload: {
          runId: failed.runId,
          stepId: failed.stepId,
          toolCallId: failed.id,
          ...(codeParentId(failed) ? { parentToolCallId: codeParentId(failed) } : {}),
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
