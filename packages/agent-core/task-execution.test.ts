import { describe, expect, it, vi } from "vitest";
import { executeAgentTask, type AgentTaskExecutionPorts } from "./task-execution.js";
import type { AgentEventEnvelope, AgentTaskRequest } from "../agent-protocol/index.js";

function fixture() {
  const events: AgentEventEnvelope[] = [];
  const input: AgentTaskRequest = {
    protocolVersion: "1", taskId: "task", prompt: "inspect",
    source: { nodeId: "cloud", kind: "cloud", protocolVersion: "1" },
    target: { nodeId: "local", kind: "local", protocolVersion: "1" },
    capabilities: [{ capability: "file.read", risk: "read", resource: "repo/a" }],
  };
  const ports: AgentTaskExecutionPorts = {
    identity: input.target!,
    executor: { execute: vi.fn(async () => "done") },
    authorize: vi.fn(async () => true),
    publish: event => events.push(event),
  };
  return { events, input, ports };
}

describe("shared Agent task execution", () => {
  it("authorizes before executing and emits ordered versioned lifecycle events", async () => {
    const { input, ports, events } = fixture();
    expect(await executeAgentTask(input, ports)).toMatchObject({ type: "completed", result: "done" });
    expect(events.map(e => e.event.type)).toEqual(["accepted", "capability-requested", "capability-resolved", "started", "completed"]);
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every(e => e.protocolVersion === "1" && e.nodeId === "local")).toBe(true);
    expect(ports.executor.execute).toHaveBeenCalledOnce();
  });

  it("does not invoke the executor when a required capability is denied", async () => {
    const { input, ports, events } = fixture();
    ports.authorize = vi.fn(async () => false);
    expect(await executeAgentTask(input, ports)).toMatchObject({ type: "failed", code: "capability-denied" });
    expect(ports.executor.execute).not.toHaveBeenCalled();
    expect(events.at(-1)?.event.type).toBe("failed");
  });

  it("cancels even when the executor ignores AbortSignal, suppressing late output", async () => {
    const { input, ports, events } = fixture();
    const controller = new AbortController();
    let emit: ((text: string) => void) | undefined;
    let resolve!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    ports.executor.execute = vi.fn(async (_, context) => {
      emit = context.emit;
      started();
      return new Promise<string>(r => { resolve = r; });
    });
    const result = executeAgentTask(input, ports, controller.signal);
    await ready;
    controller.abort();
    expect(await result).toMatchObject({ type: "cancelled" });
    const length = events.length;
    emit?.("late output");
    resolve("late result");
    await Promise.resolve();
    expect(events).toHaveLength(length);
    expect(events.at(-1)?.event.type).toBe("cancelled");
  });

  it("does not execute a task cancelled before submission", async () => {
    const { input, ports } = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await executeAgentTask(input, ports, controller.signal)).toMatchObject({ type: "cancelled" });
    expect(ports.authorize).not.toHaveBeenCalled();
    expect(ports.executor.execute).not.toHaveBeenCalled();
  });

  it("does not run or publish a task addressed to a different node", async () => {
    const { input, ports, events } = fixture();
    input.target!.nodeId = "other";
    // Separate the receiver identity from the mutated sender target.
    ports.identity = { nodeId: "local", kind: "local", protocolVersion: "1" };
    await expect(executeAgentTask(input, ports)).rejects.toThrow("incompatible");
    expect(ports.executor.execute).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("redacts execution errors at the protocol boundary", async () => {
    const { input, ports, events } = fixture();
    ports.executor.execute = vi.fn(async () => { throw new Error("SECRET /private/workspace"); });
    expect(await executeAgentTask(input, ports)).toMatchObject({ type: "failed", code: "execution-failed" });
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
});
