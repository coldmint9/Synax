import { beforeEach, expect, it, vi } from "vitest";

/** Mirrors Rust `composition`: every message is scored on its own JSON plus 4,
 * the tool schemas and the request base are charged once per request. */
type Composition = { system: number; messages: number; tools: number };
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../sidecar/runtime-repository.js", () => ({
  runtimeClient: () => ({ historyCommand: mocks.command }),
  decode: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
}));
import { measureContextPrompt, measureGroups, MEASURE_FRAME_BUDGET_BYTES } from "../context-measure.js";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const frameBytes = (group: { prompt: unknown[]; tools: unknown[] }) => size({ prompt: group.prompt, tools: group.tools });

function composition(payload: { prompt: unknown[]; tools: unknown[] }): Composition {
  const result: Composition = { system: 0, messages: 0, tools: size(payload.tools ?? []) };
  for (const message of payload.prompt) {
    const count = size(message) + 4;
    if ((message as { role?: string }).role === "system") result.system += count;
    else result.messages += count;
  }
  return result;
}

beforeEach(() => {
  mocks.command.mockReset();
  mocks.command.mockImplementation(async ({ payload }: { payload: { prompt: unknown[]; tools: unknown[] } }) =>
    Buffer.from(JSON.stringify(composition(payload))));
});

it("measures a prompt that fits one frame with a single request", async () => {
  const tools = [{ name: "read" }];
  const prompt = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const expected = composition({ prompt: [{ role: "system", content: "system" }, ...prompt], tools });
  await expect(measureContextPrompt({ sessionId: "s", systemPrompt: "system", tools, prompt }))
    .resolves.toBe(expected.system + expected.messages + expected.tools + 3);
  expect(mocks.command).toHaveBeenCalledTimes(1);
});

it("splits a multi-megabyte prompt into frames below the sidecar limit", async () => {
  const tools = [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const prompt = Array.from({ length: 6 }, (_, index) => ({ role: "user", content: `${index}:`.concat("上下文".repeat(30_000)) }));
  const groups = measureGroups({ systemPrompt: "system", tools }, prompt);
  expect(groups.length).toBeGreaterThan(1);
  for (const group of groups) expect(frameBytes(group)).toBeLessThan(1024 * 1024);
  expect(groups.flatMap(group => group.prompt).slice(1)).toEqual(prompt);
  // The system prompt and schemas ride exactly once, on the first frame.
  expect(groups[0]).toMatchObject({ tools });
  for (const group of groups.slice(1)) expect(group.tools).toEqual([]);

  const total = await measureContextPrompt({ sessionId: "s", systemPrompt: "system", tools, prompt });
  const expected = composition({ prompt: [{ role: "system", content: "system" }, ...prompt], tools });
  expect(total).toBe(expected.system + expected.messages + expected.tools + 3);
  expect(mocks.command.mock.calls.length).toBe(groups.length);
});

it("keeps media payloads out of the measurement frames", async () => {
  const prompt = [{ role: "user", content: [{ type: "image", data: new Uint8Array(400_000).fill(7) }] }];
  const groups = measureGroups({ systemPrompt: "system", tools: [] }, prompt);
  expect(groups).toHaveLength(1);
  expect(frameBytes(groups[0])).toBeLessThan(8 * 1024);
  expect(JSON.stringify(groups[0])).toContain("retained-attachment");
});

it("honours a smaller wire budget without changing the total", async () => {
  const tools: unknown[] = [];
  const prompt = Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `${index}`.repeat(2_000) }));
  const defaultTotal = await measureContextPrompt({ sessionId: "s", systemPrompt: "system", tools, prompt });
  mocks.command.mockClear();
  const splitTotal = await measureContextPrompt({ sessionId: "s", systemPrompt: "system", tools, prompt, frameBudgetBytes: 4 * 1024 });
  expect(mocks.command.mock.calls.length).toBeGreaterThan(1);
  expect(splitTotal).toBe(defaultTotal);
  for (const [{ payload }] of mocks.command.mock.calls) expect(size(payload)).toBeLessThan(MEASURE_FRAME_BUDGET_BYTES);
});
