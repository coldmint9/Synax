import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  selection: vi.fn(),
  stream: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("../session-commit-message-context.js", () => ({
  collectCommitMessageContext: mocks.context,
}));
vi.mock("../../llm-runtime/gateway.js", () => ({
  resolveGatewaySelection: mocks.selection,
  createGatewayStreamForSelection: mocks.stream,
}));
vi.mock("../usage-projection.js", () => ({
  startAuxUsage: mocks.start,
  finishAuxUsage: mocks.finish,
}));
import {
  prepareCommitMessageGeneration,
  streamSessionCommitMessage,
} from "../session-commit-message-stream.js";

const context = {
  projectId: "p1",
  branch: "main",
  changedFiles: " M file.ts",
  stagedSummary: "",
  unstagedSummary: "file.ts | 1 +",
  diffExcerpt: "+fixed",
  subjects: ["fix(ui): 上次修复", "feat(api): add route"],
};
const input = { model: "custom-api:glm/glm-5.3-flash", rootId: "primary" };
async function collect(signal = new AbortController().signal) {
  const prepared = await prepareCommitMessageGeneration("s1", input);
  const events = [];
  for await (const event of streamSessionCommitMessage(prepared, signal))
    events.push(event);
  return events;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue(context);
  mocks.selection.mockResolvedValue({
    providerId: "custom-api:glm",
    modelId: "glm-5.3-flash",
    provider: { supported: true },
  });
  mocks.start.mockReturnValue("aux1");
});
describe("commit message generation", () => {
  it("streams visible text and normalizes a history-aware final message with thinking enabled", async () => {
    mocks.stream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: '"fix(ui): ' };
        yield { type: "text-delta", text: '修复交互"' };
        yield {
          type: "finish",
          totalUsage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
        };
      })(),
    });
    expect(await collect()).toEqual([
      { type: "delta", text: '"fix(ui): ' },
      { type: "delta", text: '修复交互"' },
      { type: "final", message: "fix(ui): 修复交互" },
    ]);
    expect(mocks.context).toHaveBeenCalledWith("s1", "primary");
    const request = mocks.stream.mock.calls[0][0];
    expect(request).toMatchObject({
      projectId: "p1",
      purpose: "commit-message",
      model: input.model,
      reasoningEffort: "high",
      maxTokens: 4096,
    });
    expect(request.messages[0].content).toContain("fix(ui): 上次修复");
    expect(request.messages[0].content).toContain("+fixed");
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("rejects empty text and finishes usage", async () => {
    mocks.stream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "finish", totalUsage: {} };
      })(),
    });
    await expect(collect()).rejects.toThrow(/empty/i);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("rejects a length-limited partial subject", async () => {
    mocks.stream.mockResolvedValue({ fullStream: (async function* () {
      yield { type: "text-delta", text: "fix: partial" };
      yield { type: "finish", finishReason: "length", totalUsage: {} };
    })() });
    await expect(collect()).rejects.toThrow(/output tokens/i);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("passes abort to gateway and finishes usage", async () => {
    const controller = new AbortController();
    mocks.stream.mockImplementation(async (_request, _selection, signal) => {
      expect(signal).toBe(controller.signal);
      return {
        fullStream: (async function* () {
          controller.abort();
          yield { type: "text-delta", text: "partial" };
        })(),
      };
    });
    await expect(collect(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
});
