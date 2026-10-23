import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { runtimeClient, decode } from "../sidecar/runtime-repository.js";
import { randomUUID } from "node:crypto";
import { patchRuntime } from "../sidecar/runtime-repository.js";

beforeEach(resetAgentRuntimeFixtures);
afterEach(() => vi.restoreAllMocks());

it("refreshes new messages and non-UI entities without rereading existing collections", async () => {
  const session = agentSessionRuntime.create(executorInput);
  store.updateSession(session.id, { status: "completed" });
  for (let index = 0; index < 30; index++) store.appendMessage({ id: `old-${index}`, sessionId: session.id,
    runId: null, stepId: null, role: "assistant", content: "old data".repeat(200), metadata: {}, createdAt: `2026-10-23T00:00:${String(index).padStart(2,"0")}Z` });
  await store.hydrateSession(session.id, true);
  const client = runtimeClient();
  await client.historyCommandGlobal({ sessionId: session.id, requestId: randomUUID(), operation: "append_entities", payload: { objects: [
    { kind: "runtime.message", value: { id: "new-message", sessionId: session.id, role: "assistant", content: "new data", metadata: {}, sequence: 100, createdAt: "now" } },
    { kind: "runtime.work", value: { id: "work-remote", sessionId: session.id, status: "active" } },
    { kind: "runtime.aux_usage", value: { id: "usage-remote", sessionId: session.id, usage: { inputTokens: 42 } } },
  ] } });
  const reads = vi.spyOn(client, "historyCommandGlobal");
  await store.hydrateSession(session.id, true);
  expect(store.getMessage(session.id, "new-message")?.content).toBe("new data");
  expect(store.getRecord("work", "work-remote")).toMatchObject({ status: "active" });
  expect(store.getRecord("aux_usage", "usage-remote")).toMatchObject({ usage: { inputTokens: 42 } });
  expect(reads.mock.calls.some(([c]) => c.operation.startsWith("list_"))).toBe(false);
  expect(reads.mock.calls.filter(([c]) => c.operation === "history_updates")).toHaveLength(1);
  expect(store.listMessages(session.id).filter(message => message.id.startsWith("old-"))).toHaveLength(30);
  reads.mockClear();
  await store.hydrateSession(session.id, true);
  const read = reads.mock.calls.findIndex(([c]) => c.operation === "history_updates");
  const page = decode<{ items: unknown[] }>(await reads.mock.results[read].value);
  expect(page.items).toHaveLength(0);
});

it("evicts sealed transcript from execution cache but retains current work and evidence", async () => {
  const session = agentSessionRuntime.create(executorInput);
  store.updateSession(session.id, { status: "completed", activeRunId: null });
  for (let index = 0; index < 300; index++) store.appendMessage({ id: `history-${index}`, sessionId: session.id,
    runId: null, stepId: null, role: "assistant", content: `old ${index}`, metadata: {}, createdAt: "2026-10-23T00:00:00Z" });
  store.appendRun({ id: "old-run", sessionId: session.id, status: "completed", startedAt: "2026-10-23T00:00:00Z",
    completedAt: "2026-10-23T00:01:00Z", triggerMessageId: null, currentStep: 1, model: null, metadata: {}, stopReason: "stop" });
  store.saveRecord("work", { id: "current-work", sessionId: session.id, status: "active", evidence: [{ toolCallIds: ["proof"] }], verifications: [] });
  store.saveRecord("tool_call", { id: "proof", sessionId: session.id, status: "completed", toolId: "verification.run" });
  store.updateSessionMetadata(session.id, { activeWorkId: "current-work" });
  store.appendRunStep({ id: "last-step", sessionId: session.id, runId: "old-run", index: 1, status: "completed", model: null,
    startedAt: "2026-10-23T00:00:00Z", completedAt: "2026-10-23T00:01:00Z", finishReason: "stop", metadata: {} });
  await store.hydrateSession(session.id, true);
  await patchRuntime(session.id, "compaction_lock", { ownerId: "fixture-owner", hostId: "fixture" });
  const client = runtimeClient();
  const cmd = async (operation: string, payload: unknown) => decode<any>(await client.historyCommandGlobal({ sessionId: session.id, requestId: randomUUID(), operation, payload }));
  const head = await cmd("context_current", {});
  const active = await cmd("context_begin", { runId: "compact", stepId: "compact-step", throughStepId: "last-step", expectedRevision: head.revision, ownerId: "fixture-owner" });
  await cmd("context_commit", { ownerId: "fixture-owner", checkpoint: {
    version: 1, id: "fork_fixture", sessionId: session.id, compactionRunId: "compact", throughRevision: active.throughRevision,
    throughStepId: "last-step", sourceFingerprint: active.sourceFingerprint, createdAt: "2026-10-23T00:02:00Z", sourceRefs: [],
    summary: { goal: ["continue"], constraints: [], decisions: [], completedWork: [], evidence: [], failures: [], openQuestions: [], nextActions: [] },
  } });
  await patchRuntime(session.id, "compaction_unlock", { ownerId: "fixture-owner" });
  await store.hydrateExecutionSession(session.id, true);
  expect(store.listMessages(session.id).filter(message => message.id.startsWith("history-"))).toHaveLength(0);
  expect(store.getRecord("work", "current-work")).toMatchObject({ status: "active" });
  expect(store.getRecord("tool_call", "proof")).toBeDefined();
  const { contextReferenceTool } = await import("../context-projection.js");
  const archived = await contextReferenceTool.execute({ sessionId: session.id,
    args: { kind: "message", id: "history-0", offset: 0, limit: 1000 } } as never);
  expect(archived.result).toMatchObject({ text: "old 0", historical: true });
  const checkpoint = await contextReferenceTool.execute({ sessionId: session.id,
    args: { kind: "checkpoint", id: "fork_fixture", offset: 0, limit: 12000 } } as never);
  expect(JSON.stringify(checkpoint.result)).toContain("throughRevision");
  expect(store.listMessages(session.id)).toHaveLength(1); // only the special run marker
  const appended = store.appendMessage({ id: "new-input", sessionId: session.id, runId: null, stepId: null,
    role: "user", content: "continue", metadata: {}, createdAt: "2026-10-23T00:03:00Z" });
  expect((appended as { sequence?: number }).sequence).toBeGreaterThan(300);
  await store.hydrateExecutionSession(session.id, true);
  expect(store.listMessages(session.id).filter(message => message.id.startsWith("history-"))).toHaveLength(0);
  // A UI/history caller explicitly requesting full data still gets the source.
  await store.hydrateSession(session.id, true);
  expect(store.listMessages(session.id).filter(message => message.id.startsWith("history-"))).toHaveLength(300);
}, 30_000);
