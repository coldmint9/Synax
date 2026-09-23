import { extensionStore } from "../extensions/extension-store.js";
import { customToolProvider } from "../extensions/custom-tool-provider.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";
import { resolveWorkspacePath as resolveUndoPath } from "./tools/workspace.js";
import { withCheckpointMutation } from "./checkpoints/mutations.js";
import { assertHistoryUnlocked } from "./checkpoints/guards.js";
import { mediaReadTool } from "./tools/media-read.js";
import { mediaGenerateTool } from "./tools/media-generate.js";
import { mediaAudioVideoTools } from "./tools/media-audio-video.js";
import {
  contentPartsSchema,
  type RuntimeContentPart,
} from "./content-parts.js";
import { bindAssets, validateAssets, sessionHasAsset } from "./media-assets.js";
import { assertRuntimeExecutionCurrent } from "../../db/index.js";
import { workTools } from "./tools/work-tools.js";
import { verificationTool } from "./tools/verification.js";
import { workRuntime } from "./work-runtime.js";
import { workStore } from "./work-store.js";
import { workspaceFingerprint } from "./work-fingerprint.js";
import { withCommandSignal } from "./tools/exec-async.js";
import { resolvePermissionDecision } from "./permission-policy.js";
import {
  specialistSpecSchema,
  buildSpecialistChildInput,
  assertSpecialistToolAllowed,
} from "./specialist-profile.js";
import { controlTools } from "./control-tools.js";
import { controlToolError } from "./control-policy.js";
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
  AgentNotFoundError,
  AgentPermissionError,
  AgentValidationError,
} from "./runtime-errors.js";
import { sandboxPolicy, withSandboxApproval } from "./sandbox/index.js";
import { workspaceRoot } from "./tools/workspace.js";
import { invalidateSessionEnvironment } from "./session-environment.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentSessionRuntime } from "./session-runtime.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { sessionHooks } from "./session-hooks.js";
import { logger } from "../../lib/logger.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { mcpSessionToolProvider } from "../mcp/mcp-session-tool-provider.js";
import { INVALID_TOOL, INVALID_TOOL_ID } from "./tool-invalid.js";
import { diffReadTool } from "./tools/diff-read.js";
import { fileGlobTool } from "./tools/file-glob.js";
import { fileListTool } from "./tools/file-list.js";
import { editTool } from "./tools/edit.js";
import { patchTool } from "./tools/patch.js";
import { bashTool } from "./tools/bash.js";
import { fileReadTool } from "./tools/file-read.js";
import { fileDeleteTool } from "./tools/file-delete.js";
import { fileWriteTool } from "./tools/file-write.js";
import { grepSearchTool } from "./tools/grep-search.js";
import { webSearchTool } from "./tools/web-search.js";
import {
  buildExplorerSubagentPrompt,
  shouldWrapExplorerDelegatePrompt,
} from "./synax/synax-explorer-delegate.js";
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

  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly permissions: PermissionPolicy = permissionPolicy,
    private readonly events: AgentEventService = agentEventService,
    private readonly evidence: EvidenceService = evidenceService,
    private readonly profiles: ProfileService = profileService,
  ) {
    [
      ...controlTools,
      ...workTools,
      verificationTool,
      bashTool,
      fileReadTool,
      mediaReadTool,
      mediaGenerateTool,
      ...mediaAudioVideoTools,
      fileListTool,
      fileGlobTool,
      grepSearchTool,
      webSearchTool,
      diffReadTool,
      fileWriteTool,
      editTool,
      patchTool,
      fileDeleteTool,
      taskCreateTool,
      taskUpdateTool,
      taskGetTool,
      taskListTool,
      ...browserTools,
      INVALID_TOOL,
    ].forEach((tool) => this.register(tool));
    this.registerProvider(mcpSessionToolProvider);
    this.registerProvider(customToolProvider);
    this.register({
      id: "subagent.delegate",
      label: "Run Subtask",
      description:
        "Delegate a focused subtask to a child agent with a clean context. Use this when a task would produce large intermediate noise (reading many files, searching, exploring) but the final useful result is just a short summary. The child runs in isolation — its intermediate steps do NOT enter your context, only the final summary returns. Do NOT delegate if: the task is simple (1-2 tool calls), you need the intermediate details for subsequent reasoning, or the task cannot be described in one focused prompt.",
      category: "task",
      internalGate: "task",
      mutability: "task",
      resumeBehavior: "auto",
      progressiveDetails:
        "Use a builtin profileId or define specialist: { name, role, instructions, capabilities, skillIds, writeScope? }, plus prompt, deliverable and acceptanceCriteria. Specialists are scoped to this task. One child level; at most 3 active children. No shell; file writes need an explicit scope.",
      inputSchema: z.object({
        contentParts: contentPartsSchema.optional(),
        specialist: specialistSpecSchema.optional(),
        deliverable: z.string().min(1).max(4000).optional(),
        acceptanceCriteria: z
          .array(z.string().min(1).max(1000))
          .max(20)
          .optional(),
        profileId: z
          .string()
          .optional()
          .describe(
            "Child agent profile. Defaults to explorer. Must be a subagent-capable profile.",
          ),
        prompt: z
          .string()
          .min(1)
          .describe("Bounded prompt for the child agent session."),
        nodeId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Optional graph node context for the child session."),
        thinkingMode: z
          .enum(["fast", "standard", "deep"])
          .optional()
          .describe("Child session thinking mode."),
      }),
      execute: (input) => {
        const MAX_CONCURRENT_SUBTASKS = 3;

        const parent = this.store.getSession(input.sessionId);

        if (parent.parentSessionId) {
          throw new AgentValidationError(
            "Sub-agents cannot delegate further sub-agents.",
          );
        }

        const args = input.args as {
          contentParts?: RuntimeContentPart[];
          profileId?: string;
          prompt: string;
          nodeId?: string | null;
          thinkingMode?: "fast" | "standard" | "deep";
          specialist?: import("./specialist-profile.js").SpecialistSpec;
          deliverable?: string;
          acceptanceCriteria?: string[];
        };
        if (args.contentParts) {
          validateAssets(args.contentParts, parent.projectId);
          for (const part of args.contentParts)
            if (
              part.type !== "text" &&
              !sessionHasAsset(parent.id, part.assetId)
            )
              throw new AgentValidationError(
                "Only assets attached to the parent may be delegated.",
              );
        }
        if (args.specialist && args.profileId)
          throw new AgentValidationError(
            "Choose specialist or profileId, not both.",
          );
        const profileId = args.specialist
          ? "specialist"
          : (args.profileId ?? "explorer");

        const ALLOWED_SUBTASK_PROFILES = [
          "explorer",
          "reviewer",
          "wiki-explorer",
          "wiki-verifier",
          "wiki-package-explorer",
        ];
        if (!args.specialist && !ALLOWED_SUBTASK_PROFILES.includes(profileId)) {
          throw new AgentValidationError(
            `Subtask profile must be one of: ${ALLOWED_SUBTASK_PROFILES.join(", ")}. Got "${profileId}".`,
          );
        }
        if (!args.prompt?.trim())
          throw new AgentValidationError(
            "prompt is required for subagent.delegate.",
          );

        const childPrompt = shouldWrapExplorerDelegatePrompt(profileId)
          ? buildExplorerSubagentPrompt(args.prompt)
          : args.prompt.trim();

        // Concurrency check: count active children of the immediate parent
        const siblings = (parent.childSessionIds ?? [])
          .map((id) => {
            try {
              return this.store.getSession(id);
            } catch {
              return null;
            }
          })
          .filter(
            (s) =>
              s &&
              [
                "queued",
                "running",
                "waiting_permission",
                "waiting_input",
              ].includes(s.status),
          );
        if (siblings.length >= MAX_CONCURRENT_SUBTASKS) {
          throw new AgentValidationError(
            `Maximum concurrent subtasks (${MAX_CONCURRENT_SUBTASKS}) reached. Wait for existing subtasks to complete.`,
          );
        }

        if (
          args.specialist?.capabilities.some((c) =>
            ["file.write", "edit", "file.delete"].includes(c),
          ) &&
          siblings.some(
            (s) =>
              (
                s!.sessionMetadata?.specialist as
                  | { writeScope?: string[] }
                  | undefined
              )?.writeScope?.length,
          )
        )
          throw new AgentValidationError(
            "A specialist writer is already active. Delegate writes serially.",
          );
        if (args.specialist?.writeScope?.length) {
          for (const capability of args.specialist.capabilities.filter((c) =>
            ["file.write", "edit", "file.delete"].includes(c),
          ))
            for (const scope of args.specialist.writeScope) {
              const action = resolvePermissionDecision({
                sessionId: parent.id,
                category: "write",
                internalGate: capability === "file.delete" ? "delete" : "write",
                pattern: scope,
                rules: parent.permissionRules,
              }).action;
              if (action !== "allow")
                throw new AgentValidationError(
                  "Writable specialists require parent write permissions already granted for their scope. Ask the user to grant them or delegate read-only and apply changes on the parent.",
                );
            }
          if (
            this.store
              .listToolCalls(parent.id)
              .some(
                (c) =>
                  c.status === "running" &&
                  (c.mutability === "write" ||
                    c.toolId === "bash" ||
                    c.category === "mcp"),
              )
          )
            throw new AgentValidationError(
              "Parent workspace operation is still running. Delegate writer tasks separately.",
            );
        }
        const child = agentSessionRuntime.create(
          args.specialist
            ? buildSpecialistChildInput(
                parent,
                {
                  specialist: args.specialist,
                  prompt: args.prompt,
                  deliverable: args.deliverable,
                  acceptanceCriteria: args.acceptanceCriteria,
                  thinkingMode: args.thinkingMode,
                },
                this.profiles.getForSession(parent),
              )
            : {
                projectId: parent.projectId,
                sessionMetadata: {
                  mode: parent.sessionMetadata?.mode ?? "chat",
                },
                mcpServerIds: parent.mcpServerIds,
                skillIds: parent.skillIds,
                nodeId: args.nodeId ?? parent.nodeId,
                profileId,
                parentSessionId: parent.id,
                prompt: childPrompt,
                thinkingMode: args.thinkingMode,
              },
        );
        if (args.contentParts) {
          const parts: RuntimeContentPart[] = [
            { type: "text", text: childPrompt },
            ...args.contentParts,
          ];
          bindAssets(child.id, parts);
          this.store.updateSessionMetadata(child.id, {
            initialContentParts: parts,
          });
        }
        return {
          result: {
            taskId: child.id,
            session: child,
            summary: `Child session ${child.id} (${profileId}) created.`,
          },
          displaySummary: `Started ${profileId} subtask ${child.id}.`,
          artifacts: [
            {
              kind: "decision",
              title: "Subtask created",
              summary: `Started ${profileId} child session ${child.id}.`,
              risk: "low",
            },
          ],
          followUpHints: [
            "The parent agent blocks until this subtask completes and returns its summary.",
          ],
        };
      },
    });
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
        "Accepts { skillId: string } and returns full content only after the runtime gate.",
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
        isToolMountedForSession(session, t) &&
        (options.includeGated || !controlToolError(session, t)) &&
        (session.profileId !== "specialist" ||
          profileCanUseTool(effective, t) ||
          t.id === INVALID_TOOL_ID),
    );
  }

  get(toolId: string): RegisteredTool {
    const tool = this.tools.get(toolId);
    if (!tool) throw new AgentNotFoundError(toolId);
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
  ): Promise<ExecuteToolResult> {
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
    const tool = this.getForSession(sessionId, record.toolId);
    if (record.status !== "pending") {
      return { record, permission };
    }
    return this.performExecution(
      sessionId,
      tool,
      record,
      record.inputRef,
      permission,
      abortSignal,
    );
  }

  async execute(
    sessionId: string,
    toolId: string,
    args: unknown,
    options: ExecuteToolOptions = {},
  ): Promise<ExecuteToolResult> {
    const session = this.store.getSession(sessionId);
    const profile = this.profiles.getForSession(session);
    const tool = this.getForSession(sessionId, toolId);

    const controlError = controlToolError(session, tool, args);
    if (
      controlError ||
      (!profileCanUseTool(profile, tool) &&
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

    if (decision.action === "ask" && session.profileId === "specialist") {
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
    );
  }

  private async performExecution(
    sessionId: string,
    tool: RegisteredTool,
    record: ToolCallRecord,
    args: unknown,
    permission?: PermissionDecision,
    abortSignal?: AbortSignal,
  ): Promise<ExecuteToolResult> {
    try {
      abortSignal?.throwIfAborted();
      const freshSession = this.store.getSession(sessionId);
      const policyError = controlToolError(freshSession, tool, args);
      if (policyError) throw new AgentValidationError(policyError);
      assertSpecialistToolAllowed(freshSession, tool.id, args);
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
        if (freshSession.parentSessionId && root.status !== "running")
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
      const input: ToolExecutionInput = {
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
      const inApprovalScope = <T>(action: () => T): T =>
        approved
          ? withSandboxApproval(
              sessionId,
              approvalPaths.filter(
                (value): value is string => typeof value === "string",
              ),
              action,
            )
          : action();
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
          tool.category === "mcp");
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
      assertRuntimeExecutionCurrent();
      assertHistoryUnlocked(sessionId);
      const executeTool = () => {
        // Recording a large before-image may yield. Recheck cancellation and
        // ownership immediately before the native tool is allowed to write.
        if (!extensionStore.active(this.store.getSession(sessionId).projectId, "tool", tool.id)) throw new AgentPermissionError(`Tool ${tool.id} has been removed or disabled.`);
        abortSignal?.throwIfAborted();
        assertRuntimeExecutionCurrent();
        assertHistoryUnlocked(sessionId);
        return inApprovalScope(() => withCommandSignal(abortSignal, () => tool.execute(input)));
      };
      const checkpointMutation =
        tool.mutability === "write" ||
        tool.id === "bash" ||
        tool.id === "verification.run" ||
        tool.category === "mcp";
      let undoPaths: string[] | undefined;
      if (
        ["file.write", "edit", "file.delete"].includes(tool.id) &&
        typeof (args as { path?: unknown }).path === "string"
      )
        undoPaths = [
          resolveUndoPath((args as { path: string }).path, sessionId),
        ];
      if (tool.id === "file.patch")
        undoPaths = parseApplyPatchEnvelope((args as { patch: string }).patch)
          .flatMap((hunk) => [
            hunk.path,
            ...("movePath" in hunk && hunk.movePath ? [hunk.movePath] : []),
          ])
          .map((file) => resolveUndoPath(file, sessionId));
      const result = checkpointMutation
        ? await withCheckpointMutation(sessionId, executeTool, false, undoPaths)
        : await executeTool();
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
      const status =
        result.displaySummary.length > SUMMARY_LIMIT
          ? "compacted"
          : "completed";

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
          status,
          followUpHints: result.followUpHints ?? [],
        },
      });
      return { record: completed, permission, toolResult: result };
    } catch (error) {
      const work = workStore.current(sessionId);
      if (
        work &&
        !["completed", "cancelled"].includes(work.status) &&
        (tool.mutability === "write" ||
          tool.id === "bash" ||
          tool.id === "verification.run" ||
          tool.category === "mcp")
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
