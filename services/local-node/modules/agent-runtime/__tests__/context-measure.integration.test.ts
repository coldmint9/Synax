import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { runtimeClient } from "../sidecar/runtime-repository.js";
import { measureContextPrompt } from "../context-measure.js";

beforeEach(ensureTestRuntime);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

async function measure(sessionId: string, payload: { prompt: unknown[]; tools: unknown[] }) {
  return JSON.parse(Buffer.from(await runtimeClient().historyCommand({
    sessionId, requestId: randomUUID(), operation: "context_measure", payload,
  })).toString()) as { system: number; messages: number; tools: number; total: number };
}

async function seed(sessionId: string): Promise<void> {
  await runtimeClient().seedUi(sessionId, Buffer.from(JSON.stringify({
    id: sessionId, projectId: "test", status: "completed", activeRunId: null,
    pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString(),
  })));
}

/** A near-budget provider prompt spans several MiB and cannot cross the control
 * socket in one frame, which is what used to abort compaction. */
it("measures a prompt larger than one control frame", async () => {
  const sessionId = `ars_${randomUUID().replaceAll("-", "")}`;
  await seed(sessionId);
  const tools = [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const systemPrompt = "system instructions";
  // Roughly the 795k-token transcript that used to abort compaction.
  const prompt = Array.from({ length: 10 }, (_, index) => ({ role: "user", content: `${index}:`.concat("上下文".repeat(30_000)) }));
  expect(bytes(prompt)).toBeGreaterThan(2 * 1024 * 1024);

  // The single-frame path the client rejected before the fix.
  await expect(measure(sessionId, { prompt, tools })).rejects.toThrow("frame exceeds the client limit");

  const calls = vi.spyOn(runtimeClient(), "historyCommand");
  try {
    const total = await measureContextPrompt({ sessionId, systemPrompt, tools, prompt });
    const groups = calls.mock.calls
      .filter(([input]) => input.operation === "context_measure")
      .map(([input]) => input.payload as { prompt: unknown[]; tools: unknown[] });
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(bytes(group)).toBeLessThan(1024 * 1024);

    // Rust scores every message independently, so per-message measurements are
    // the exact oracle for the split total.
    const base = await measure(sessionId, { prompt: [{ role: "system", content: systemPrompt }], tools });
    let expected = base.system + base.tools + 3;
    for (const message of prompt) expected += (await measure(sessionId, { prompt: [message], tools: [] })).messages;
    expect(total).toBe(expected);
  } finally {
    calls.mockRestore();
  }
});

it("keeps the single-request total for a prompt that fits one frame", async () => {
  const sessionId = `ars_${randomUUID().replaceAll("-", "")}`;
  await seed(sessionId);
  const tools = [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const prompt = [{ role: "user", content: "查看 src/index.ts" }, { role: "assistant", content: "已读取" }];
  const single = await measure(sessionId, { prompt: [{ role: "system", content: "system instructions" }, ...prompt], tools });
  await expect(measureContextPrompt({ sessionId, systemPrompt: "system instructions", tools, prompt })).resolves.toBe(single.total);
});
