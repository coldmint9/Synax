import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitMessageFile } from "../session-commit-message-context.js";
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
vi.mock("../../../infrastructure/llm-runtime/gateway.js", () => ({
  resolveGatewaySelection: mocks.selection,
  createGatewayStreamForSelection: mocks.stream,
}));
vi.mock("../usage-projection.js", () => ({
  startAuxUsage: mocks.start,
  finishAuxUsage: mocks.finish,
}));
import {
  COMMIT_MESSAGE_CONCURRENCY,
  prepareCommitMessageGeneration,
  streamSessionCommitMessage,
} from "../session-commit-message-stream.js";

function file(name: string, additions = 1): CommitMessageFile {
  return {
    path: name,
    status: "M",
    additions,
    deletions: 0,
    binary: false,
    patch: "+fixed",
  };
}

function context(files: CommitMessageFile[] = [file("file.ts")]) {
  return {
    projectId: "p1",
    branch: "main",
    stagedSummary: "",
    unstagedSummary: "file.ts | 1 +",
    subjects: ["fix(ui): 上次修复", "feat(api): add route"],
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, item) => sum + item.additions, 0),
      deletions: 0,
    },
  };
}

const input = { model: "custom-api:glm/glm-5.3-flash", rootId: "primary" };

async function collect(
  signal = new AbortController().signal,
  options: { timeoutMs?: number; locale?: "zh" | "en" } = {},
) {
  const prepared = await prepareCommitMessageGeneration("s1", {
    ...input,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
  });
  const events = [];
  for await (const event of streamSessionCommitMessage(prepared, signal))
    events.push(event);
  return events;
}

function streamText(text: string, finish: Record<string, unknown> = {}) {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text };
      yield { type: "finish", totalUsage: {}, ...finish };
    })(),
  };
}

function pending() {
  return {
    fullStream: (async function* () {
      await new Promise<void>(() => {});
    })(),
  };
}

const finalEvent = (events: unknown[]) =>
  events.at(-1) as { message: string; warning?: string };
const promptOf = (call: number) =>
  mocks.stream.mock.calls[call][0].messages[0].content as string;
const batchOf = (prompt: string) => Number(/batch (\d+)\/(\d+)/.exec(prompt)?.[1]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue(context());
  mocks.selection.mockResolvedValue({
    providerId: "custom-api:glm",
    modelId: "glm-5.3-flash",
    provider: { supported: true },
    modelDef: { id: "glm-5.3-flash", label: "GLM" },
    // The connection declares what the endpoint accepts; "none" disables thinking.
    config: { supportedReasoningEfforts: ["none", "low", "medium", "high"] },
  });
  mocks.start.mockReturnValue("aux1");
});

describe("commit message generation", () => {
  it("sends one template request for one batch and asks for a grouped summary", async () => {
    mocks.stream.mockResolvedValue(
      streamText('"fix(ui): 修复交互\n\n- fix(ui): 修复按钮 (file.ts)'),
    );
    expect(await collect()).toEqual([
      {
        type: "final",
        message: "fix(ui): 修复交互\n\n- fix(ui): 修复按钮 (file.ts)",
      },
    ]);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(mocks.context).toHaveBeenCalledWith("s1", "primary");
    const request = mocks.stream.mock.calls[0][0];
    expect(request).toMatchObject({
      projectId: "p1",
      purpose: "commit-message",
      model: input.model,
      // A formatting task asks for no thinking when the model allows it.
      reasoningEffort: "none",
      maxTokens: 8_192,
    });
    const prompt = request.messages[0].content;
    for (const expected of [
      "Write a commit message in the conventional commit convention.",
      "Keep the title within 74 characters",
      "End commit title with issue number if you can get it from the branch name: main in parenthesis.",
      "Previous commit messages:",
      "fix(ui): 上次修复",
      "+fixed",
      "Use English language to answer.",
      "Never write one bullet per file",
    ])
      expect(prompt).toContain(expected);
    for (const leftover of [
      "$hint",
      "{Use this hint",
      "{locale}",
      "{branch}",
      "{previousCommitMessages}",
      "{diff}",
    ])
      expect(prompt).not.toContain(leftover);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("summarizes an answer without bullets by area instead of by file", async () => {
    mocks.stream.mockResolvedValue(
      streamText("feat(git): 改用模板\n\n正文说明。#123"),
    );
    const events = [];
    const prepared = await prepareCommitMessageGeneration("s1", {
      ...input,
      locale: "zh",
    });
    for await (const event of streamSessionCommitMessage(
      prepared,
      new AbortController().signal,
    ))
      events.push(event);
    expect(promptOf(0)).toContain("Use Chinese (Simplified) language to answer.");
    expect(events.at(-1)).toEqual({
      type: "final",
      message:
        "feat(git): 改用模板\n\n- chore(repo): 更新 1 个文件（+1 −0）",
    });
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("generates large commits in parallel batches and merges one message", async () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      file(`client/src/features/area-${index % 7}/Panel${index}.tsx`, 30 - index),
    );
    mocks.context.mockResolvedValue(context(files));
    const startedAt: number[] = [];
    mocks.stream.mockImplementation(async (request: { messages: { content: string }[] }) => {
      startedAt.push(Date.now());
      const batch = batchOf(request.messages[0].content);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return streamText(
        [
          `feat(workspace): 第 ${batch} 批完成`,
          "",
          `- feat(workspace): 完成第 ${batch} 批 (${files[(batch - 1) * 12].path})`,
        ].join("\n"),
      );
    });
    const events = await collect(undefined, { timeoutMs: 5_000 });
    const message = finalEvent(events).message;
    expect(mocks.stream).toHaveBeenCalledTimes(3);
    // Batches overlap: a sequential run would take three times as long.
    const spread = Math.max(...startedAt) - Math.min(...startedAt);
    expect(spread).toBeLessThan(30);
    expect(message.split("\n")[0]).toBe("feat(workspace): 第 1 批完成");
    // Every batch kept its own model bullet, so the answers were merged, not replaced.
    for (const batch of [1, 2, 3])
      expect(message).toContain(
        `- feat(workspace): 完成第 ${batch} 批 (${files[(batch - 1) * 12].path})`,
      );
    // A grouped body names only the paths its own bullets chose.
    expect(message).toContain(files[0].path);
    expect(message).not.toContain(files[1].path);
    expect(message.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
      3,
    );
    expect(finalEvent(events).warning).toBeUndefined();
    // Each batch prompt only carries its own files.
    for (const [call, size] of [12, 12, 6].entries()) {
      const prompt = promptOf(call);
      const named = new Set(prompt.match(/client\/src\/features\/area-\d\/Panel\d+\.tsx/g));
      expect(named.size).toBe(size);
      expect(prompt).toContain(`batch ${call + 1}/3`);
    }
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("gives every batch its own deadline instead of sharing one budget", async () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      file(`src/batch-${index}.ts`, 30 - index),
    );
    mocks.context.mockResolvedValue(context(files));
    mocks.stream.mockImplementation(async (request: { messages: { content: string }[] }) => {
      const batch = batchOf(request.messages[0].content);
      // The middle batch never answers: only its own deadline can end it.
      if (batch === 2) return pending();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return streamText(
        `feat: 第 ${batch} 批\n\n- feat(a): 完成第 ${batch} 批 (src/batch-${(batch - 1) * 12}.ts)`,
      );
    });
    const startedAt = Date.now();
    const events = await collect(undefined, { timeoutMs: 80, locale: "zh" });
    const elapsed = Date.now() - startedAt;
    // The stalled batch ends on its own 80ms deadline, not after the others.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(1_000);
    const final = finalEvent(events);
    expect(final.message.split("\n")[0]).toBe("feat: 第 1 批");
    expect(final.warning).toBeTruthy();
    // The batches that answered keep their bullets; the stalled one is grounded.
    expect(final.message).toContain("- feat(a): 完成第 1 批 (src/batch-0.ts)");
    expect(final.message).toContain("- feat(a): 完成第 3 批 (src/batch-24.ts)");
    // The stalled batch becomes one area line, not twelve file lines.
    const stalledAdditions = files
      .slice(12, 24)
      .reduce((sum, item) => sum + item.additions, 0);
    expect(final.message).toContain(
      `- chore(src): 更新 12 个文件（+${stalledAdditions} −0）`,
    );
    expect(final.message).not.toContain("src/batch-12.ts");
  });
  it("keeps the number of parallel batches bounded", async () => {
    const files = Array.from({ length: 60 }, (_, index) =>
      file(`src/pool-${index}.ts`, 60 - index),
    );
    mocks.context.mockResolvedValue(context(files));
    let inFlight = 0;
    let peak = 0;
    mocks.stream.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return streamText("feat: 分批\n");
    });
    const events = await collect(undefined, { timeoutMs: 5_000 });
    expect(mocks.stream).toHaveBeenCalledTimes(5);
    expect(peak).toBe(COMMIT_MESSAGE_CONCURRENCY);
    // No batch answered with bullets, so one area line stands for all 60 files.
    const message = finalEvent(events).message;
    expect(message).toContain("- chore(src): update 60 files");
    expect(message.split("\n")).toHaveLength(3);
  });
  it("still generates a complete message when every batch fails", async () => {
    const files = [file("src/a.ts"), file("src/b.ts")];
    mocks.context.mockResolvedValue(context(files));
    mocks.stream.mockRejectedValue(new Error("provider unavailable"));
    const final = finalEvent(await collect());
    expect(final.message.startsWith("chore(repo): update 2 files")).toBe(true);
    expect(final.message).toContain("- chore(src): update 2 files (+2 -0)");
    // A failed generation still summarizes by area instead of listing paths.
    expect(final.message).not.toContain("src/a.ts");
    expect(final.warning).toMatch(/summarizes the changed files by area/i);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("names the provider failure instead of claiming the model never finished", async () => {
    mocks.stream.mockRejectedValue(new Error("HTTP 401: invalid api key"));
    const final = finalEvent(await collect());
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(final.warning).toContain("HTTP 401: invalid api key");
    expect(final.warning).toMatch(/summarizes the changed files by area/i);
  });
  it("spends one more attempt on a batch that answered nothing", async () => {
    mocks.stream
      .mockRejectedValueOnce(new Error("provider overloaded"))
      .mockResolvedValue(
        streamText("fix(git): 重试成功\n\n- fix(git): 修复按钮 (file.ts)"),
      );
    const final = finalEvent(await collect());
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(final.message.split("\n")[0]).toBe("fix(git): 重试成功");
    expect(final.message).toContain("- fix(git): 修复按钮 (file.ts)");
    expect(final.warning).toBeUndefined();
  });
  it("does not retry a batch that already spent its deadline", async () => {
    mocks.stream.mockImplementation(async () => pending());
    const final = finalEvent(await collect(undefined, { timeoutMs: 20 }));
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(final.warning).toBeTruthy();
  });
  it("still generates a complete message when a batch times out", async () => {
    mocks.stream.mockImplementation(async () => ({
      fullStream: (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield { type: "text-delta", text: "late" };
      })(),
    }));
    const final = finalEvent(await collect(undefined, { timeoutMs: 10 }));
    expect(final.message.startsWith("chore(repo): update 1 file")).toBe(true);
    expect(final.message).toContain("- chore(repo): update 1 file (+1 -0)");
    expect(final.warning).toBeTruthy();
  });
  it("reports an empty answer as a degraded message instead of failing", async () => {
    mocks.stream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "finish", totalUsage: {} };
      })(),
    });
    const final = finalEvent(await collect());
    expect(final.message).toContain("- chore(repo): update 1 file (+1 -0)");
    expect(final.warning).toBeTruthy();
  });
  it("keeps complete lines from a length-limited answer", async () => {
    mocks.stream.mockResolvedValue(
      streamText("feat: 标题\n\n- feat(a): 部分 (file.ts", {
        finishReason: "length",
      }),
    );
    const final = finalEvent(await collect());
    expect(final.message.startsWith("feat: 标题")).toBe(true);
    expect(final.message).toContain("- chore(repo): update 1 file (+1 -0)");
    expect(final.message).not.toContain("部分");
    expect(final.warning).toContain("the output token limit was reached");
  });
  it("keeps a low effort when the model cannot switch thinking off", async () => {
    mocks.selection.mockResolvedValue({
      providerId: "anthropic",
      modelId: "claude-sonnet-5-5",
      provider: { supported: true },
      modelDef: { id: "claude-sonnet-5-5", label: "Sonnet" },
      config: { supportedReasoningEfforts: ["low", "medium", "high"] },
    });
    mocks.stream.mockResolvedValue(
      streamText("feat(a): 标题\n\n- feat(a): 完成 (file.ts)"),
    );
    await collect();
    expect(mocks.stream.mock.calls[0][0].reasoningEffort).toBe("low");
  });
  it("falls back to the previous effort when no-thinking is rejected", async () => {
    mocks.stream
      .mockRejectedValueOnce(new Error("unsupported reasoning effort"))
      .mockResolvedValue(
        streamText("feat(a): 标题\n\n- feat(a): 完成 (file.ts)"),
      );
    const final = finalEvent(await collect());
    expect(mocks.stream.mock.calls[0][0].reasoningEffort).toBe("none");
    expect(mocks.stream.mock.calls[1][0].reasoningEffort).toBe("low");
    expect(final.warning).toBeUndefined();
  });
  it("propagates user cancellation instead of degrading", async () => {
    const controller = new AbortController();
    mocks.stream.mockImplementation(async (_request, _selection, signal) => {
      expect(signal.aborted).toBe(false);
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
