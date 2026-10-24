import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ command: vi.fn(), generate: vi.fn(), emit: vi.fn() }));
vi.mock("../sidecar/runtime-repository.js", () => ({
  runtimeClient: () => ({ historyCommand: mocks.command }),
  decode: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
}));
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({ generateGatewayTextResult: mocks.generate }));
vi.mock("../../../infrastructure/runtime/ipc/agent-session-protocol.js", () => ({ emitSessionLive: mocks.emit }));
import { runSessionCheckpoint, type CheckpointHead } from "../checkpoint-service.js";

let head: CheckpointHead;
let loseCommit: boolean;
let failCurrentReads: number;
let failCommitOnce: boolean;
const summary = { goal: ["Investigate"], constraints: [], decisions: [], completedWork: [], evidence: [], failures: [], openQuestions: [], nextActions: ["Continue"] };
const input = () => ({ sessionId: "s", projectId: "p", model: "fixture", budget: { contextLimit: 10_000, outputReserve: 2048 }, summaryBudget: 500, validate: vi.fn(async () => true) });

beforeEach(() => {
  vi.clearAllMocks();
  head = { checkpoint: null, active: null, revision: 20, generation: 1, latestStepId: "last-step" };
  loseCommit = false;
  failCurrentReads = 0;
  failCommitOnce = false;
  mocks.generate.mockResolvedValue({ text: JSON.stringify({ summary, sourceRefs: [] }), finishReason: "stop", usage: { inputTokens: 25, outputTokens: 50 } });
  mocks.command.mockImplementation(async ({ operation, payload }: { operation: string; payload: Record<string, unknown> }) => {
    let result: unknown = {};
    if (operation === "context_current") {
      if (failCurrentReads > 0 && head.active) {
        failCurrentReads--;
        throw new Error("checkpoint head unavailable");
      }
      result = head;
    }
    else if (operation === "context_begin") {
      head.active = { runId: payload.runId as string, stepId: payload.stepId as string, status: "running",
        throughRevision: 20, throughStepId: "last-step", sourceFingerprint: "a".repeat(64),
        indexGeneration: 1, startedAt: "2026-10-23T00:00:00Z" };
      result = head.active;
    } else if (operation === "context_messages") result = {
      items: [{ objectId: "object-1", role: "assistant", text: "Observed evidence", offset: 0 }], cursor: null,
    };
    else if (operation === "context_finish") head.active!.status = payload.status as string;
    else if (operation === "context_commit") {
      if (failCommitOnce) {
        failCommitOnce = false;
        throw new Error("temporary history transport failure");
      }
      head.checkpoint = payload.checkpoint as CheckpointHead["checkpoint"];
      head.active!.status = "completed";
      if (loseCommit) throw new Error("ack lost");
    }
    return Buffer.from(JSON.stringify(result));
  });
});

it("retries an idempotent commit without regenerating the summary", async () => {
  failCommitOnce = true;
  const result = await runSessionCheckpoint(input());
  expect(result?.sessionId).toBe("s");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.command.mock.calls.filter(([c]) => c.operation === "context_commit")).toHaveLength(2);
});

it("uses a same-session run and commits only after complete-request validation", async () => {
  const request = input();
  const result = await runSessionCheckpoint(request);
  expect(result?.sessionId).toBe("s");
  const operations = mocks.command.mock.calls.map(([c]) => c.operation);
  expect(operations).toEqual(["context_current", "context_begin", "context_messages", "append_entities", "context_commit"]);
  expect(request.validate).toHaveBeenCalledWith(result);
  expect(mocks.emit.mock.calls.map(([, e]) => e.state.status)).toEqual(["running", "completed"]);
  expect(head.checkpoint).toEqual(result);
});

it("reconciles a lost commit response without repeating the LLM request", async () => {
  loseCommit = true;
  const result = await runSessionCheckpoint(input());
  expect(result).toEqual(head.checkpoint);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.command.mock.calls.some(([c]) => c.operation === "context_finish")).toBe(false);
  expect(mocks.emit.mock.calls.at(-1)?.[1].state.status).toBe("completed");
});

it("commits the deterministic fallback when the provider call fails", async () => {
  mocks.generate.mockRejectedValueOnce(new Error("provider failed"));
  const result = await runSessionCheckpoint(input());
  expect(result?.summary.evidence).toContain("Observed evidence");
  expect(head.active?.status).toBe("completed");
  expect(mocks.command.mock.calls.some(([c]) => c.operation === "context_finish")).toBe(false);
});

it("never publishes a boundary after failed full-request validation", async () => {
  expect(await runSessionCheckpoint({ ...input(), validate: () => false })).toBeNull();
  expect(head.checkpoint).toBeNull();
  expect(head.active?.status).toBe("completed");
  expect(mocks.command.mock.calls.some(([c]) => c.operation === "context_commit")).toBe(false);
});

it("cancels late provider output and closes the special run", async () => {
  const controller = new AbortController();
  mocks.generate.mockImplementation(async () => {
    controller.abort(new Error("cancelled"));
    return { text: JSON.stringify({ summary, sourceRefs: [] }), finishReason: "stop", usage: {} };
  });
  await expect(runSessionCheckpoint({ ...input(), signal: controller.signal })).rejects.toThrow("cancelled");
  expect(head.checkpoint).toBeNull();
  expect(head.active?.status).toBe("interrupted");
  expect(mocks.emit.mock.calls.at(-1)?.[1].state.status).toBe("failed");
});

it("does no work without a new completed step", async () => {
  head.latestStepId = null;
  expect(await runSessionCheckpoint(input())).toBeNull();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.emit).not.toHaveBeenCalled();
});

it("recompacts an existing bounded summary after a smaller model is selected", async () => {
  head.checkpoint = {
    version: 1, id: "old-checkpoint", sessionId: "s", compactionRunId: "old-run", throughRevision: 20,
    throughStepId: "last-step", sourceFingerprint: "a".repeat(64), createdAt: "2026-10-23T00:00:00Z",
    summary: { ...summary, evidence: ["Previous evidence ".repeat(1000)] }, sourceRefs: [],
  };
  head.checkpointObjectId = "sha256:previous";
  const result = await runSessionCheckpoint({ ...input(), recompact: true });
  expect(result?.throughRevision).toBe(20);
  expect(result?.summary).toEqual(summary);
  expect(mocks.generate.mock.calls.some(([request]) => JSON.stringify(request.messages).includes("Previous evidence"))).toBe(true);
});
