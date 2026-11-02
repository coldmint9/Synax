import { describe, it, expect } from "vitest";
import { buildLoopModelMessages } from "../loop-model-messages.js";
import { snapshotRuntimeReminder } from "../runtime-request-snapshot.js";
import type { PatchDiagnostic } from "../tools/patch-diagnostics.js";

function createMockStore(data: {
  messages?: Array<{ id: string; role: string; content: string }>;
  runs?: Array<{ id: string; triggerMessageId: string; startedAt: string }>;
  steps?: Array<{
    id: string;
    runId: string;
    index: number;
    metadata?: Record<string, unknown>;
  }>;
  parts?: Array<{
    id: string;
    stepId: string;
    kind: string;
    content: string;
    toolCallId?: string;
  }>;
  toolCalls?: Array<{
    id: string;
    runId: string;
    stepId: string;
    toolId: string;
    modelToolCallId?: string;
    status: string;
    inputRef?: unknown;
    outputRef?: unknown;
    outputSummary?: string;
    error?: string;
    inputSummary?: string;
  }>;
}) {
  return {
    listMessages: (sessionId: string) => data.messages ?? [],
    listRuns: (sessionId: string) => data.runs ?? [],
    listRunSteps: (runId: string) =>
      (data.steps ?? []).filter((s) => s.runId === runId),
    listToolCalls: (sessionId: string) => data.toolCalls ?? [],
    listRunToolCalls: (runId: string) =>
      (data.toolCalls ?? []).filter((tc) => tc.runId === runId),
    listRunParts: (stepId: string) =>
      (data.parts ?? []).filter((p) => p.stepId === stepId),
    listSessionSteps: (sessionId: string) => data.steps ?? [],
    listSessionParts: (sessionId: string) => data.parts ?? [],
  } as any;
}

const mockToolSet = {
  resolveModelToolName: (toolId: string) => toolId,
};

describe("buildLoopModelMessages", () => {
  it.each([false, true])("retains complete patch recovery under output-budget pressure (saved receipt: %s)", (saved) => {
    const diagnostic: PatchDiagnostic = {
      error: true, code: "PATCH_CONTEXT_MISMATCH", applied: false,
      message: "Failed to find expected lines", path: "source.ts", hunkIndex: 2,
      expectedExcerpt: { lines: Array.from({ length: 12 }, () => "old source ".repeat(20)), truncated: true },
      actualExcerpt: { startLine: 38, lines: Array.from({ length: 12 }, () => "new source ".repeat(20)), truncated: true },
      recovery: "Read the current source, then submit a corrected patch; do not replay unchanged.",
      suggestedRead: { path: "source.ts", startLine: 41, lineCount: 20 },
    };
    const serialized = JSON.stringify(diagnostic);
    expect(serialized.length).toBeGreaterThan(4000);
    const store = createMockStore({
      messages: [{ id: "u", role: "user", content: "Fix source" }],
      runs: [{ id: "r", triggerMessageId: "u", startedAt: "" }],
      steps: [{ id: "s", runId: "r", index: 1, metadata: saved ? {
        contextProjectionVersion: 2,
        toolContextReceipts: { t: { version: 1, outputType: "error-text", text: "Old clipped failure without recovery" } },
      } : {} }],
      parts: [{ id: "p", stepId: "s", kind: "tool_call", content: "", toolCallId: "t" }],
      toolCalls: [{ id: "t", runId: "r", stepId: "s", toolId: "file.patch", status: "failed",
        outputRef: diagnostic, error: "Legacy short error", inputRef: { patch: "patch" } }],
    });
    const messages = buildLoopModelMessages(store, "session", mockToolSet, {
      toolOutputBudgetTokens: 1,
      clearing: { priorInputTokens: 100, contextLimit: 100, threshold: 0.5, keepRecent: 0, excludeTools: [], forceActivated: true },
    });
    const toolMessage = messages.find(message => message.role === "tool")!;
    expect(toolMessage.content).toEqual([expect.objectContaining({
      type: "tool-result", toolName: "file.patch", output: { type: "error-text", value: serialized },
    })]);
  });

  it.each([
    ["file.patch", "failed", "error-text"],
    ["file.read", "failed", "error-text"],
    ["file.patch", "denied", "execution-denied"],
  ])("keeps ordinary %s %s results unchanged", (toolId, status, outputType) => {
    const store = createMockStore({
      messages: [{ id: "u", role: "user", content: "Work" }],
      runs: [{ id: "r", triggerMessageId: "u", startedAt: "" }],
      steps: [{ id: "s", runId: "r", index: 1 }],
      parts: [{ id: "p", stepId: "s", kind: "tool_call", content: "", toolCallId: "t" }],
      toolCalls: [{ id: "t", runId: "r", stepId: "s", toolId, status, error: "Original failure",
        outputRef: { error: true, message: "Other payload" } }],
    });
    const messages = buildLoopModelMessages(store, "session", mockToolSet, { toolOutputBudgetTokens: 1 });
    expect(messages.find(message => message.role === "tool")!.content).toEqual([expect.objectContaining({
      output: outputType === "execution-denied"
        ? { type: outputType, reason: "Original failure" }
        : { type: outputType, value: "Original failure" },
    })]);
  });

  function loadedSkillsFixture() {
    const content = "Skill requirement. ".repeat(400) + "FINAL_REQUIRED_INSTRUCTION";
    const store = createMockStore({
      messages: [{ id: "u", role: "user", content: "Work" }],
      runs: [{ id: "r", triggerMessageId: "u", startedAt: "" }],
      steps: [{ id: "s", runId: "r", index: 1 }],
      parts: [{ id: "p", stepId: "s", kind: "tool_call", content: "", toolCallId: "t" }],
      toolCalls: [{ id: "t", runId: "r", stepId: "s", toolId: "skill.load", status: "completed", inputRef: { skillId: "project/test" }, outputRef: { id: "project/test", content } }],
    });
    return { store, content };
  }

  it("preserves full successful skill instructions beyond generic output limits", () => {
    const { store, content } = loadedSkillsFixture();
    const messages = buildLoopModelMessages(store, "session", mockToolSet);
    expect(JSON.stringify(messages)).toContain(content);
  });

  it("restores compacted skill instructions only after current eligibility checks", () => {
    const { store, content } = loadedSkillsFixture();
    const options = { excludedStepIds: new Set(["s"]), compactionSummary: "Summary", canRetainSkill: (id: string) => id === "project/test" };
    const messages = buildLoopModelMessages(store, "session", mockToolSet, options);
    expect(JSON.stringify(messages)).toContain(content);
    expect(JSON.stringify(messages)).toContain("do not reload");
    expect(JSON.stringify(buildLoopModelMessages(store, "session", mockToolSet, { ...options, canRetainSkill: () => false }))).not.toContain(content);
  });

  it("tracks generated summaries and runtime reminders separately without changing wire messages", () => {
    const runtimeReminder = snapshotRuntimeReminder({}, ["Runtime facts"], []);
    const userText = "<system-reminder>User-quoted material</system-reminder>";
    const store = createMockStore({
      messages: [{ id: "m1", role: "user", content: userText }],
      runs: [{ id: "r1", triggerMessageId: "m1", startedAt: "" }],
      steps: [
        { id: "s1", runId: "r1", index: 1, metadata: { runtimeReminder } },
      ],
      parts: [{ id: "p1", stepId: "s1", kind: "text", content: "Answer" }],
    });
    const systemMessageContents = new Set<string>();
    const messages = buildLoopModelMessages(store, "session", mockToolSet, {
      compactionSummary: "Retained summary",
      systemMessageContents,
    });
    expect(messages).toEqual(
      buildLoopModelMessages(store, "session", mockToolSet, {
        compactionSummary: "Retained summary",
      }),
    );
    expect(systemMessageContents).toEqual(
      new Set([messages[0].content, runtimeReminder.content]),
    );
    expect(messages.filter((message) => message.content === runtimeReminder.content)).toEqual([
      { role: "system", content: runtimeReminder.content },
    ]);
    expect(messages.find((message) => message.content === userText)?.role).toBe("user");
    expect(systemMessageContents.has(userText)).toBe(false);
    expect(systemMessageContents.has("Answer")).toBe(false);
  });
  it("filters out tool_results without matching tool_use in assistant content", () => {
    const store = createMockStore({
      messages: [{ id: "msg1", role: "user", content: "hello" }],
      runs: [
        {
          id: "run1",
          triggerMessageId: "msg1",
          startedAt: "2026-01-01T00:00:00Z",
        },
      ],
      steps: [{ id: "step1", runId: "run1", index: 1 }],
      parts: [
        { id: "p1", stepId: "step1", kind: "text", content: "thinking..." },
      ],
      toolCalls: [
        {
          id: "tc1",
          runId: "run1",
          stepId: "step1",
          toolId: "file.read",
          modelToolCallId: "call_00_orphaned",
          status: "completed",
          outputRef: "file content",
          inputRef: { path: "/foo" },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, "session1", mockToolSet);

    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(0);

    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    const content = assistantMessages[0].content as any[];
    expect(content.every((c: any) => c.type !== "tool-call")).toBe(true);
  });

  it("includes tool_results that have matching tool_use in assistant content", () => {
    const store = createMockStore({
      messages: [{ id: "msg1", role: "user", content: "hello" }],
      runs: [
        {
          id: "run1",
          triggerMessageId: "msg1",
          startedAt: "2026-01-01T00:00:00Z",
        },
      ],
      steps: [{ id: "step1", runId: "run1", index: 1 }],
      parts: [
        {
          id: "p1",
          stepId: "step1",
          kind: "tool_call",
          content: "",
          toolCallId: "tc1",
        },
      ],
      toolCalls: [
        {
          id: "tc1",
          runId: "run1",
          stepId: "step1",
          toolId: "file.read",
          modelToolCallId: "call_00_valid",
          status: "completed",
          outputRef: "file content",
          inputRef: { path: "/foo" },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, "session1", mockToolSet);

    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    const content = assistantMessages[0].content as any[];
    expect(
      content.some(
        (c: any) => c.type === "tool-call" && c.toolCallId === "call_00_valid",
      ),
    ).toBe(true);

    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0].content as any[];
    expect(toolContent[0].toolCallId).toBe("call_00_valid");
  });

  it("handles resume scenario: mixed valid and orphaned tool calls", () => {
    const store = createMockStore({
      messages: [{ id: "msg1", role: "user", content: "hello" }],
      runs: [
        {
          id: "run1",
          triggerMessageId: "msg1",
          startedAt: "2026-01-01T00:00:00Z",
        },
      ],
      steps: [{ id: "step1", runId: "run1", index: 1 }],
      parts: [
        {
          id: "p1",
          stepId: "step1",
          kind: "tool_call",
          content: "",
          toolCallId: "tc1",
        },
      ],
      toolCalls: [
        {
          id: "tc1",
          runId: "run1",
          stepId: "step1",
          toolId: "file.read",
          modelToolCallId: "call_00_valid",
          status: "completed",
          outputRef: "content1",
          inputRef: { path: "/a" },
        },
        {
          id: "tc2",
          runId: "run1",
          stepId: "step1",
          toolId: "file.read",
          modelToolCallId: "call_00_orphaned",
          status: "completed",
          outputRef: "content2",
          inputRef: { path: "/b" },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, "session1", mockToolSet);

    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0].content as any[];
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0].toolCallId).toBe("call_00_valid");
  });
});
