import { beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { runtimeClient, persistEntity } from "../sidecar/runtime-repository.js";
import { readHistoryList } from "../sidecar/history-pages.js";
import { boundedStreamChunk, streamBatchGroups } from "../runtime-stream-projection.js";
import type { AgentRunStreamChunk, ToolCallRecord } from "../contracts.js";

beforeEach(ensureTestRuntime);

it("writes and reads a result larger than one frame while sending only its preview", async () => {
  const sessionId = `ars_${randomUUID().replaceAll("-", "")}`;
  await runtimeClient().seedUi(sessionId, Buffer.from(JSON.stringify({ id: sessionId, projectId: "test", status: "completed", activeRunId: null, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() })));
  const tool = { id: "large-result", sessionId, runId: "r", stepId: "step", toolId: "rg", status: "completed",
    inputSummary: "search", outputSummary: "Large result", inputRef: {}, outputRef: { text: "结果".repeat(250_000) },
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } as ToolCallRecord;
  await persistEntity(sessionId, "runtime.tool_call", tool);
  const saved = await readHistoryList<ToolCallRecord>(runtimeClient(), sessionId, "list_tool_calls");
  expect(saved[0].outputRef).toEqual(tool.outputRef);
  const chunk: AgentRunStreamChunk = { type: "tool_result", runId: "r", stepId: "step", toolCall: tool };
  const preview = boundedStreamChunk(chunk);
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(8192);
  expect(preview).toMatchObject({ toolCall: { id: tool.id, outputRef: null } });
  expect(tool.outputRef).toEqual(saved[0].outputRef);
});

it("splits stream bursts by encoded bytes before allocating producer sequence numbers", () => {
  const chunks = Array.from({ length: 40 }, () => ({ type: "message_delta", runId: "r", stepId: "s", delta: "中".repeat(10_000) }) as AgentRunStreamChunk);
  const groups = streamBatchGroups(chunks);
  expect(groups.length).toBeGreaterThan(1);
  expect(groups.flat()).toEqual(chunks);
  for (const group of groups) expect(Buffer.byteLength(JSON.stringify(group))).toBeLessThan(512 * 1024);
});
