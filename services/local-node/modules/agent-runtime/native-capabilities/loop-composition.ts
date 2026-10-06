import type { AgentRuntimeStore } from "../session-store.js";
import type { StructuredToolCall } from "../contracts.js";
import type { ToolRegistry, ExecuteToolResult } from "../tool-registry.js";
import { canComposeTool } from "../code-mode/policy.js";

interface Operation {
  call: StructuredToolCall;
  state: "queued" | "running" | "settled" | "pending" | "cancelled" | "uncertain";
  recordId?: string;
}
interface Program { version: 1; operations: Operation[]; error?: string }
export interface Execution { call: StructuredToolCall; exec: ExecuteToolResult }

/** The loop owns the program. Models submit ordinary operations, never choose
 * whether to use Code Mode. Input order is a dependency order across writes.
 * Persist BEFORE execution; a crash with no terminal receipt is never replayed. */
export class LoopComposition {
  constructor(private store: AgentRuntimeStore, private registry: ToolRegistry) {}

  private load(stepId: string): Program | undefined {
    return this.store.getRunStep(stepId).metadata?.composition as Program | undefined;
  }
  private save(stepId: string, program: Program) {
    const step = this.store.getRunStep(stepId);
    this.store.updateRunStep(stepId, { metadata: { ...step.metadata, composition: program } });
  }
  hasProgram(stepId: string): boolean { return Boolean(this.load(stepId)); }

  async execute(sessionId: string, runId: string, stepId: string,
    calls: StructuredToolCall[], signal?: AbortSignal): Promise<Execution[]> {
    const program = this.load(stepId) ?? { version: 1, operations: calls.map((call) => ({ call, state: "queued" })) } as Program;
    this.save(stepId, program);
    const output: Execution[] = [];
    // Reconcile durable receipts after approval/restart without executing them.
    for (const op of program.operations) {
      if (op.state !== "running" && op.state !== "pending") continue;
      const record = op.recordId ? this.store.getToolCall(sessionId, op.recordId) :
        this.store.listToolCalls(sessionId).find((item) => item.stepId === stepId && item.modelToolCallId === op.call.id);
      if (record && ["completed", "compacted", "failed", "denied", "cancelled"].includes(record.status)) {
        op.recordId = record.id;
        op.state = "settled";
        if (["failed", "denied", "cancelled"].includes(record.status)) this.cancelTail(program);
      } else if (record?.status === "pending") {
        op.recordId = record.id;
        op.state = "pending";
        this.save(stepId, program);
        return [{ call: op.call, exec: { record, permission: record.permissionDecisionId ? this.store.listPermissions(sessionId).find((item) => item.id === record.permissionDecisionId) : undefined } }];
      } else {
        op.state = "uncertain";
        program.error = `Execution of ${op.call.toolId} was interrupted without a terminal receipt. Inspect its effects before retrying.`;
      }
    }
    this.save(stepId, program);
    if (program.error) throw new Error(program.error);

    const parallelRead = (op: Operation) => {
      const session = this.store.getSession(sessionId);
      const tool = this.registry.getForSession(sessionId, op.call.toolId);
      // Permission-sensitive reads are serialized to avoid multiple open approvals.
      return session.sessionMetadata?.permissionTier === "unrestricted" && tool.mutability === "read" &&
        canComposeTool(session, tool);
    };
    for (let index = 0; index < program.operations.length; index++) {
      const op = program.operations[index];
      if (op.state !== "queued") continue;
      signal?.throwIfAborted();
      const group = [op];
      if (parallelRead(op)) {
        while (group.length < 4 && index + 1 < program.operations.length &&
          program.operations[index + 1].state === "queued" && parallelRead(program.operations[index + 1]))
          group.push(program.operations[++index]);
      }
      const session = this.store.getSession(sessionId);
      const compiled = group.every((entry) => canComposeTool(session, this.registry.getForSession(sessionId, entry.call.toolId)));
      const execute = async (entry: Operation, abortSignal?: AbortSignal) => {
        entry.state = "running";
        this.save(stepId, program);
        const exec = await this.registry.execute(sessionId, entry.call.toolId, entry.call.args, {
          runId, stepId, modelToolCallId: entry.call.id,
          resumeToken: `${runId}:${stepId}:${entry.call.id}`, abortSignal,
        });
        entry.recordId = exec.record.id;
        entry.state = exec.record.status === "pending" ? "pending" : "settled";
        this.save(stepId, program);
        output.push({ call: entry.call, exec });
        return null;
      };
      if (compiled) {
        // The loop owns scheduling. The isolated worker remains the compatibility
        // path for legacy code calls; automatic composition keeps operation
        // arguments in the host journal and executes the bounded read batch here.
        await Promise.all(group.map((entry) => execute(entry, signal)));
      } else {
        // Control/Shell/browser operations use their own host lifecycle but
        // remain ordered by this same durable program.
        await execute(op, signal);
      }
      const receipts = output.filter(({ call }) => group.some((entry) => entry.call.id === call.id));
      if (receipts.some(({ exec }) => exec.record.status === "pending" || exec.interactionId || exec.toolResult?.suspend)) break;
      if (receipts.some(({ exec }) => ["failed", "denied", "cancelled"].includes(exec.record.status))) {
        this.cancelTail(program);
        this.save(stepId, program);
        break;
      }
    }
    return output.sort((a, b) => program.operations.findIndex((op) => op.call.id === a.call.id) - program.operations.findIndex((op) => op.call.id === b.call.id));
  }

  private cancelTail(program: Program) {
    for (const op of program.operations) if (op.state === "queued") op.state = "cancelled";
  }
}
