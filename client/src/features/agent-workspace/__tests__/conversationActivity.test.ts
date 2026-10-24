import { describe, expect, it } from "vitest";
import { conversationActivityLiveLabel, conversationActivitySummary, conversationToolPresentation } from "../conversationActivity";
import type { ToolCallView } from "../buildInterleavedTurns";

function call(toolId: string, inputSummary = "", extra: Partial<ToolCallView> = {}): ToolCallView {
  return { id: toolId, toolId, inputSummary, outputSummary: "", status: "completed", category: "tool", duration: null, mutability: "read", ...extra };
}

describe("conversation activity presentation", () => {
  it("summarizes work once per action in source order", () => {
    const calls = [call("agent.discover"), call("file.patch"), call("file.patch"), call("file.read"), call("bash"), call("bash")];
    expect(conversationActivitySummary(calls, "zh").text).toBe("加载了工具编辑了多个文件读取文件运行了命令");
    expect(conversationActivitySummary(calls, "en").text).toBe("Loaded tools, Edited files, Read files, Ran commands");
  });
  it("shows the filename but retains its full path and counts only patch lines", () => {
    const presentation = conversationToolPresentation(call("file.patch", JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/cache.rs\n@@\n-old\n+one\n+two\n*** End Patch" })), "zh");
    expect(presentation).toMatchObject({ target: "src/cache.rs", displayTarget: "cache.rs", additions: 2, deletions: 1 });
  });
  it("does not infer diff counts from a truncated patch", () => {
    const presentation = conversationToolPresentation(call("file.patch", '{"patch":"*** Update File: src/cache.rs\\n@@\\n-old\\n+new'), "zh");
    expect(presentation.additions).toBe(0);
    expect(presentation.deletions).toBe(0);
  });
  it("preserves meaningful names for non-file tools even with a write category", () => {
    const presentation = conversationToolPresentation(call("media.generate", '{"prompt":"a cat"}', { category: "write" }), "zh");
    expect(presentation).toMatchObject({ label: "已生成媒体", file: false, action: "tool" });
  });
  it("uses active language for running commands and elapsed time only after completion", () => {
    expect(conversationToolPresentation(call("bash", "npm test", { status: "running", duration: "2s" }), "zh").label).toBe("正在运行");
    expect(conversationToolPresentation(call("bash", "npm test", { duration: "36s" }), "zh").label).toBe("已在 36s 内运行");
  });
  it("maps running calls to human-readable events without exposing raw input", () => {
    expect(conversationActivityLiveLabel([call("bash", "rm -rf production", { status: "running" })], "zh")).toBe("正在执行命令");
    expect(conversationActivityLiveLabel([call("rg", "secret-token", {
      status: "running",
      execution: { phase: "executing_tool", files: 42 },
    })], "zh")).toBe("正在搜索代码 · 已扫描 42 个文件");
    expect(conversationActivityLiveLabel([call("bash", "npm test", {
      status: "running",
      execution: { phase: "queued_resources", resource: "command" },
    })], "zh")).toBe("正在准备命令执行");
    expect(conversationActivityLiveLabel([call("bash", "npm test", {
      status: "running",
      execution: { phase: "generating" },
    })], "zh")).toBe("正在整理结果");
    expect(conversationActivityLiveLabel([
      call("bash", "npm test", { status: "running" }),
      call("rg", "TODO", { status: "running" }),
    ], "zh")).toBe("正在并行处理 2 个任务");
    expect(conversationActivityLiveLabel([], "zh")).toBe("正在分析任务");
  });
});
