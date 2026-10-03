import { getProjectSettings } from "../../../infrastructure/runtime/config/project-settings-store.js";
import { withoutSandboxApproval } from "../sandbox/sandbox-policy.js";
import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionResult } from "../contracts.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { AgentRuntimeStore } from "../session-store.js";
import type { ProfileService } from "../profile-service.js";
import { profileCanUseTool } from "../tool-mount-policy.js";
import { CODE_LIMITS } from "./contracts.js";
import { canComposeTool, codeModeEnabled } from "./policy.js";
import { nestedModelCallId } from "./history.js";
import { executeCode } from "./executor.js";

function response(
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
export function createCodeTools(
  registry: ToolRegistry,
  store: AgentRuntimeStore,
  profiles: ProfileService,
): RegisteredTool[] {
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
  return [
    {
      id: "code.tools",
      label: "Code Mode Tools",
      category: "read",
      mutability: "read",
      resumeBehavior: "none",
      description:
        "Discover approved read-only tools for code.run. Search returns a small paged directory; pass toolId to load its input JSON Schema before coding. Direct tool calling remains available.",
      inputSchema: z
        .object({
          query: z.string().max(120).optional(),
          toolId: z.string().max(256).optional(),
          offset: z.number().int().min(0).max(10000).optional(),
        })
        .strict(),
      execute(input) {
        if (!codeModeEnabled(store.getSession(input.sessionId)))
          return response(
            { status: "denied" },
            "Code Mode is disabled. Use direct tools.",
          );
        const {
          query,
          toolId,
          offset = 0,
        } = input.args as { query?: string; toolId?: string; offset?: number };
        const tools = eligible(input.sessionId);
        if (toolId) {
          const tool = tools.find((item) => item.id === toolId);
          if (!tool)
            return response(
              {
                status: "denied",
                error: "Tool is not approved for Code Mode.",
              },
              "Use a tool in code.tools or call it directly.",
            );
          try {
            const schema = tool.inputSchema
              ? z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" })
              : { type: "object" };
            if (JSON.stringify(schema).length > 12000)
              throw new Error("Schema too large");
            return response(
              {
                id: tool.id,
                description: tool.description.slice(0, 1000),
                inputSchema: schema,
                usage: `await tools.call(${JSON.stringify(tool.id)}, args)`,
              },
              `Code Mode schema: ${tool.id}`,
            );
          } catch {
            return response(
              {
                status: "unavailable",
                error:
                  "Schema cannot be represented safely. Use the direct tool.",
              },
              `Use ${toolId} directly.`,
            );
          }
        }
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const matching = tools
          .filter((tool) =>
            words.every((word) =>
              `${tool.id} ${tool.description}`.toLowerCase().includes(word),
            ),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        return response(
          {
            tools: matching.slice(offset, offset + 8).map((tool) => ({
              id: tool.id,
              description: tool.description.slice(0, 240),
            })),
            total: matching.length,
            nextOffset: offset + 8 < matching.length ? offset + 8 : null,
          },
          `Code Mode: ${matching.length} matching read-only tools.`,
        );
      },
    },
    {
      id: "code.run",
      label: "Code Mode (read-only)",
      category: "read",
      mutability: "read",
      resumeBehavior: "none",
      description:
        "Run an isolated JavaScript async function body for read-only tool composition and data processing. Discover IDs/schemas with code.tools, then await tools.call(id, args). Return a small JSON summary. Promise.all is supported up to 4 concurrent calls; 32 calls and 15 seconds total. No Node, filesystem, network, imports, Shell or writes. Await ALL calls. Stateless: no automatic replay or approval inside code; use direct tools for approval or after an error.",
      inputSchema: z
        .object({ code: z.string().min(1).max(CODE_LIMITS.maxCodeBytes) })
        .strict(),
      async execute(input) {
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
              if (
                !eligible(input.sessionId).some((tool) => tool.id === toolId)
              ) {
                trace.status = "denied";
                throw new Error(
                  "Tool is not currently approved for Code Mode. Use code.tools or direct tools.",
                );
              }
              const executed = await withoutSandboxApproval(() =>
                registry.execute(input.sessionId, toolId, args, {
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
          `Code Mode ${status}; ${trace.length} nested calls; ${result.durationMs}ms${result.error ? `: ${result.error}` : ""}`,
        );
      },
    },
  ];
}
