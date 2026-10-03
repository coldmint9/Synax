import {
  agentProtocolVersion,
  agentTaskRequestSchema,
  type AgentCapabilityRequest,
  type AgentEventEnvelope,
  type AgentNodeIdentity,
  type AgentTaskEvent,
  type AgentTaskRequest,
} from "../agent-protocol/index.js";
import type { AgentExecutor } from "./index.js";

export interface AgentTaskExecutionPorts {
  identity: AgentNodeIdentity;
  executor: AgentExecutor<AgentTaskRequest>;
  authorize: (request: AgentCapabilityRequest, task: AgentTaskRequest, signal: AbortSignal) => Promise<boolean>;
  publish: (event: AgentEventEnvelope) => void;
}

/** The transport must authenticate the peer before invoking this application port. */
export async function executeAgentTask(
  input: unknown,
  ports: AgentTaskExecutionPorts,
  signal?: AbortSignal,
): Promise<AgentTaskEvent> {
  const task = agentTaskRequestSchema.parse(input);
  if (ports.identity.protocolVersion !== agentProtocolVersion ||
      (task.target && (task.target.nodeId !== ports.identity.nodeId || task.target.kind !== ports.identity.kind))) {
    throw new Error("Task addressed to an incompatible Agent node");
  }

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let sequence = 0;
  let terminal = false;
  const publish = (event: AgentTaskEvent) => {
    if (terminal) return;
    ports.publish({ protocolVersion: agentProtocolVersion, nodeId: ports.identity.nodeId, sequence: ++sequence, event });
  };
  const finish = (event: AgentTaskEvent) => {
    publish(event);
    terminal = true;
    return event;
  };
  let removeAbortListener = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason ?? new Error("Task cancelled"));
    if (controller.signal.aborted) onAbort();
    else {
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    }
  });

  const run = async (): Promise<AgentTaskEvent> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    for (const request of task.capabilities ?? []) {
      publish({ type: "capability-requested", taskId: task.taskId, request });
      const allowed = await ports.authorize(request, task, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      publish({ type: "capability-resolved", taskId: task.taskId, capability: request.capability, allowed });
      if (!allowed) return { type: "failed", taskId: task.taskId, code: "capability-denied", message: "Required capability was denied" };
    }
    publish({ type: "started", taskId: task.taskId });
    const result = await ports.executor.execute(task, {
      taskId: task.taskId,
      nodeId: ports.identity.nodeId,
      signal: controller.signal,
      emit: text => {
        if (!controller.signal.aborted) publish({ type: "output", taskId: task.taskId, text });
      },
    });
    return { type: "completed", taskId: task.taskId, result };
  };

  try {
    publish({ type: "accepted", taskId: task.taskId, at: new Date().toISOString() });
    const result = await Promise.race([cancelled, run()]);
    return finish(controller.signal.aborted ? { type: "cancelled", taskId: task.taskId } : result);
  } catch {
    // Never send provider errors, local paths or credentials across the node boundary.
    return finish(controller.signal.aborted
      ? { type: "cancelled", taskId: task.taskId }
      : { type: "failed", taskId: task.taskId, code: "execution-failed", message: "Agent task execution failed" });
  } finally {
    removeAbortListener();
    signal?.removeEventListener("abort", abort);
  }
}
