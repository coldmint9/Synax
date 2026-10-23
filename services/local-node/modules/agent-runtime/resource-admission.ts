import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { currentExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import type { RegisteredTool, ToolExecutionInput, ToolExecutionProgress } from "./contracts.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { resolveExecTimeoutMs } from "./tools/command-timeout.js";

// Admission starts before command setup. Allow syntax validation (10s),
// process termination (2s), guardian acknowledgement (10s), and control I/O
// to finish before the outer deadline cancels the tool and discards its result.
const COMMAND_SETUP_AND_CLEANUP_MS = 30_000;

type Resource = "search" | "io" | "command" | "cpu";
interface LeaseStatus { state: string; queuedAt: number; startedAt: number | null; deadline: number | null; queueWaitMs: number }
export interface OverdueResource { ownerId: string; sessionId: string; rootSessionId: string; id: string; runId: string; resource: string; timeoutMs: number }

/** Small independent HTTP control calls do not wait behind history/stream RPCs. */
export async function resourceRequest<T>(operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const port = Number(process.env.SYNAX_RUNTIME_PROVIDER_PORT);
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!port || !token) throw new Error("Resource scheduler is unavailable.");
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/resources/${operation}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw Object.assign(new Error(`Resource admission failed: ${await response.text()}`), { permanent: response.status < 500 });
      return await response.json() as T;
    } catch (error) {
      last = error;
      if (signal?.aborted || (error as { permanent?: boolean })?.permanent) throw error;
      if (attempt < 2) await delay(100 * (attempt + 1), undefined, { signal });
    }
  }
  throw last;
}

export function toolResourcePolicy(tool: RegisteredTool, args: unknown): { resource: Resource; timeoutMs: number } | null {
  const input = args as { timeoutMs?: number; timeout?: number } | null;
  if (["rg", "grep.search", "file.glob"].includes(tool.id)) return { resource: "search", timeoutMs: Math.min(120_000, Math.max(100, input?.timeoutMs ?? 30_000)) + 5_000 };
  // Compositions and parent waits must not retain a slot needed by their children.
  if (tool.mutability === "task" || tool.category === "task" || ["code", "code.run"].includes(tool.id) || tool.id.startsWith("subagent.")) return null;
  if (tool.id === "bash" || tool.id === "verification.run") return { resource: "command",
    timeoutMs: resolveExecTimeoutMs(input?.timeoutMs, tool.id === "verification.run" ? 120_000 : undefined) + COMMAND_SETUP_AND_CLEANUP_MS };
  if (tool.category === "shell") return { resource: "command", timeoutMs: Math.min(3_600_000, Math.max(1_000, input?.timeoutMs ?? 900_000)) };
  return { resource: tool.category === "mcp" || tool.category === "external_execution" ? "command" : "io", timeoutMs: tool.executionTimeoutMs ?? 300_000 };
}

export async function withToolResource<T>(tool: RegisteredTool, input: ToolExecutionInput,
  onState: (progress: ToolExecutionProgress) => void, action: (signal: AbortSignal | undefined) => Promise<T> | T,
): Promise<T> {
  const executionContext = currentExecutionContext();
  const policy = toolResourcePolicy(tool, input.args);
  // Embedded/unit-test hosts have no durable execution owner. Production session
  // workers always supply a context; never silently bypass a failed scheduler.
  if (!executionContext || !policy) return action(input.abortSignal);
  const ownerId = process.env.SYNAX_PROCESS_OWNER ?? `host:${executionContext.hostId}:${process.pid}`;
  const request = { id: randomUUID(), resource: policy.resource, sessionId: input.sessionId,
    rootSessionId: input.sessionId, ownerId, runId: executionContext.runId, epoch: executionContext.epoch,
    expiresAt: Date.now() + 300_000, timeoutMs: policy.timeoutMs };
  const controller = new AbortController();
  const signal = input.abortSignal ? AbortSignal.any([controller.signal, input.abortSignal]) : controller.signal;
  const queuedAt = new Date().toISOString();
  let progress: ToolExecutionProgress = { phase: "queued_resources", resource: policy.resource, queuedAt };
  onState(progress);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let finished = false;
  try {
    let status: LeaseStatus;
    do {
      signal.throwIfAborted();
      status = await resourceRequest<LeaseStatus>("request", { request, executionContext }, signal);
      if (status.state === "queued") await delay(200, undefined, { signal });
    } while (status.state === "queued");
    if (status.state !== "running" || !status.startedAt || !status.deadline) throw new Error(`Resource request ended: ${status.state}`);
    progress = { ...progress, phase: "executing_tool", startedAt: new Date(status.startedAt).toISOString(),
      deadline: new Date(status.deadline).toISOString(), queueWaitMs: status.queueWaitMs, lastProgressAt: new Date().toISOString() };
    onState(progress);
    const stop = (reason: Error) => { onState({ ...progress, phase: "cancelling" }); controller.abort(reason); };
    timer = setTimeout(() => stop(new Error(`Tool execution exceeded ${policy.timeoutMs}ms.`)), Math.max(1, status.deadline - Date.now()));
    timer.unref();
    heartbeat = setInterval(() => {
      if (polling) return;
      polling = true;
      void resourceRequest<LeaseStatus>("request", { request, executionContext }).then(state => {
        if (!finished && state.state !== "running") stop(new Error(`Resource lease is ${state.state}.`));
      }).catch(error => { if (!finished) stop(error instanceof Error ? error : new Error(String(error))); }).finally(() => { polling = false; });
    }, 5_000);
    heartbeat.unref();
    const result = await action(signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    // The action has settled, including owned-command close. No Promise.race
    // can free this lease while the underlying tool continues executing.
    await resourceRequest("release", { id: request.id, ownerId }).catch(error => {
      logger.error({ resource: policy.resource, sessionId: input.sessionId, error: String(error) }, "Resource release requires supervisor reconciliation");
    });
  }
}
