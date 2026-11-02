import { getProjectSettings } from "../../../infrastructure/runtime/config/project-settings-store.js";
import { withoutSandboxApproval } from "../sandbox/sandbox-policy.js";
import type { ToolExecutionResult, ToolExecutionInput } from "../contracts.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { AgentRuntimeStore } from "../session-store.js";
import type { ProfileService } from "../profile-service.js";
import { profileCanUseTool } from "../tool-mount-policy.js";
import { canComposeTool, codeModeEnabled } from "./policy.js";
import { nestedModelCallId } from "./history.js";
import { executeCode } from "./executor.js";
import { resolveToolName } from "../tool-name-resolution.js";

export function response(
  result: unknown,
  displaySummary: string,
): ToolExecutionResult {
  const status =
    result && typeof result === "object" && "status" in result
      ? result.status
      : undefined;
  const outcome =
    status === "denied"
      ? "denied"
      : typeof status === "string" && status !== "completed"
        ? "failed"
        : undefined;
  return {
    result,
    displaySummary,
    artifacts: [],
    ...(outcome ? { outcome } : {}),
  };
}
export function createCompositionExecutor(
  registry: ToolRegistry,
  store: AgentRuntimeStore,
  profiles: ProfileService,
  validateContract?: (sessionId: string, toolId: string) => void,
): (input: ToolExecutionInput) => Promise<ToolExecutionResult> {
  const eligible = (sessionId: string) => {
    const session = store.getSession(sessionId);
    const profile = profiles.getForSession(session);
    const config = getProjectSettings(session.projectId).codeMode;
    return registry
      .listForSession(sessionId)
      .filter(
        (tool) =>
          profileCanUseTool(profile, tool) &&
          canComposeTool(session, tool, config),
      );
  };
  return async (input) => {
    const native = input.toolId === "agent.execute";
    if (!codeModeEnabled(store.getSession(input.sessionId)))
      return response(
        { status: "denied" },
        "Code Mode is disabled. Use direct tools.",
      );
    const nestedCalls: Array<{
      toolId: string;
      toolCallId?: string;
      status: string;
      durationMs: number;
      error?: string;
    }> = [];
    const result = await executeCode({
      code: (input.args as { code: string }).code,
      signal: input.abortSignal,
      // Only already eligible read operations may share a batch. Writes and
      // unknown contracts remain barriers; execution rechecks current grants.
      canParallelTool: (toolId) => eligible(input.sessionId)
        .some(tool => tool.id === toolId && tool.mutability === "read"),
      callTool: async (toolId, args, signal) => {
        const trace: (typeof nestedCalls)[number] = {
          toolId,
          status: "running",
          durationMs: 0,
        };
        const started = Date.now();
        nestedCalls.push(trace);
        const sequence = nestedCalls.length;
        try {
          signal.throwIfAborted();
          const tools = eligible(input.sessionId);
          // Code Mode receives the same name variants as the direct tool path
          // (`write` for `file.write`); resolve them before granting anything.
          const resolution = tools.some((tool) => tool.id === toolId)
            ? null
            : resolveToolName(toolId, tools.map((tool) => tool.id));
          const resolvedId = resolution
            ? (resolution.match?.toolId ?? null)
            : toolId;
          if (!resolvedId) {
            trace.status = "denied";
            throw new Error(
              `Tool ${toolId} is not currently approved for composition.` +
                (resolution?.suggestions.length
                  ? ` Closest eligible tools: ${resolution.suggestions.join(", ")}.`
                  : "") +
                ` Use ${native ? "agent.discover" : "code.tools"} or direct tools.`,
            );
          }
          validateContract?.(input.sessionId, resolvedId);
          const executed = await withoutSandboxApproval(() =>
            registry.execute(input.sessionId, resolvedId, args, {
              runId: input.runId,
              stepId: input.stepId,
              modelToolCallId: nestedModelCallId(
                input.toolCallId,
                sequence,
              ),
              codeModeParentId: input.toolCallId,
              abortSignal: signal,
            }),
          );
          trace.toolCallId = executed.record.id;
          trace.status = executed.record.status;
          if (
            !["completed", "compacted"].includes(executed.record.status) ||
            !executed.toolResult
          )
            throw new Error(
              executed.record.error ??
                "Tool requires direct invocation/approval.",
            );
          const value = executed.toolResult.result;
          if (
            value &&
            typeof value === "object" &&
            "ok" in value &&
            value.ok === false
          )
            throw new Error(
              "MCP tool reported an error. Narrow the request or use the direct tool.",
            );
          return value;
        } catch (error) {
          if (trace.status === "running" || trace.status === "completed")
            trace.status = signal.aborted ? "cancelled" : "failed";
          trace.error = (
            error instanceof Error ? error.message : String(error)
          ).slice(0, 500);
          throw error;
        } finally {
          trace.durationMs = Date.now() - started;
        }
      },
    });
    // Calls that ignored cancellation cannot be allowed to change the returned
    // trace later. Their registry execution receives the same abort signal.
    const trace = nestedCalls.map((call) =>
      call.status === "running"
        ? { ...call, status: "cancelled" }
        : { ...call },
    );
    const status =
      result.status === "failed" &&
      trace.some((call) => call.status === "denied")
        ? "denied"
        : result.status;
    return response(
      {
        ...result,
        status,
        executionId: input.toolCallId,
        nestedCalls: trace,
        ...(status === "completed"
          ? {}
          : {
              nextAction:
                "Use direct tools for approval or narrow/fix the code. Nothing is automatically replayed.",
            }),
      },
      `${native ? "Native composition" : "Code Mode"} ${status}; ${trace.length} nested calls; ${result.durationMs}ms${result.error ? `: ${result.error}` : ""}`,
    );
  };
}
