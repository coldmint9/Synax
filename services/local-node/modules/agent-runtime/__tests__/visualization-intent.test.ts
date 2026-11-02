import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  session: { activeRunId: "run", profileId: "synax", projectId: "project" },
  run: { id: "run", triggerMessageId: "user1", metadata: {} as Record<string, unknown> },
  calls: [] as { modelToolCallId: string; toolId?: string; status?: string; outputRef?: unknown }[],
  contexts: [] as { skillId: string; content: string }[],
  canRetain: true,
  skillContent: "retained instructions",
  skills: [{ id: "synax-builtin/visualize", name: "visualize" }],
}));
vi.mock("../session-store.js", () => ({ agentRuntimeStore: {
  getSession: () => state.session,
  getRun: () => state.run,
  updateRun: (_id: string, update: { metadata: Record<string, unknown> }) => Object.assign(state.run, update),
  listRunToolCalls: () => state.calls,
  listToolCalls: () => state.calls,
  listRecords: () => state.contexts,
} }));
vi.mock("../../skills/agent-bridge.js", () => ({ skillAgentBridge: {
  listForPrompt: () => state.skills,
  canRetainForContext: (_session: string, _skill: string, content?: string) => state.canRetain && content === state.skillContent,
} }));
vi.mock("../visualization-integration.js", async () => {
  const { parseVisualization } = await import("../visualization-manifest.js");
  const { visualizationBlocks } = await import("../visualization-protocol.js");
  return {
    snapshotVisualization: (_session: string, content: string) => parseVisualization(content),
    withoutVisualizationDeclarations: (content: string) => {
      for (const block of visualizationBlocks(content).reverse()) content = content.slice(0, block.start) + content.slice(block.end);
      return content.trim();
    },
  };
});
import { presentationTool, presentationDecision, pendingPresentationSkillLoads, checkPresentationCompletion, presentationSchema } from "../presentation-runtime.js";
import type { ToolExecutionInput } from "../contracts.js";
const select = (args: Record<string, unknown> = {}) => presentationTool.execute({ sessionId: "session", args: {
  mode: "inline_visualization", requirement: "required", source: "explicit", reason: "User requested an interactive chart", ...args,
} } as ToolExecutionInput);
beforeEach(() => {
  state.run.metadata = {};
  state.calls = [];
  state.contexts = [];
  state.canRetain = true;
  state.skillContent = "retained instructions";
  state.skills = [{ id: "synax-builtin/visualize", name: "visualize" }];
});
describe("presentation lifecycle", () => {
  it("does not treat documentation or quoted protocol examples as a preview", () => {
    const content = 'The protocol uses synax-visualize.\n```text\nvisualize{"path":"/example.html"}\n```';
    expect(checkPresentationCompletion("session", content)).toEqual({ content });
  });
  it("reuses a successful manual skill load instead of loading again", async () => {
    state.calls.push({ modelToolCallId: "model-call", toolId: "skill.load", status: "completed", outputRef: { id: "synax-builtin/visualize", content: "retained instructions" } });
    state.contexts.push({ skillId: "synax-builtin/visualize", content: state.skillContent });
    await select();
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
  });
  it("reuses durable instructions on a new input without depending on tool history", async () => {
    state.contexts.push({ skillId: "synax-builtin/visualize", content: state.skillContent });
    await select();
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
    state.run.metadata.turnReferenceInputId = "user2";
    await select({ source: "continuation" });
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
  });
  it.each(["changed", "permission", "missing"])("does not reuse %s skill context", async (reason) => {
    state.calls.push({ modelToolCallId: "old-call", toolId: "skill.load", status: "completed", outputRef: { id: "synax-builtin/visualize", content: state.skillContent } });
    if (reason !== "missing") state.contexts.push({ skillId: "synax-builtin/visualize", content: state.skillContent });
    if (reason === "changed") state.skillContent = "Updated instructions";
    if (reason === "permission") state.canRetain = false;
    await select();
    expect(pendingPresentationSkillLoads("session")).toHaveLength(1);
  });
  it.each(["", "   "])("does not accept an empty required result: %j", async content => {
    await select();
    expect(checkPresentationCompletion("session", content).retry).toBeTruthy();
    expect(checkPresentationCompletion("session", content).content).toContain("交互预览未完成");
  });
  it("schedules an ordinary skill load once per input and survives replay", async () => {
    await select();
    const [call] = pendingPresentationSkillLoads("session");
    expect(call).toMatchObject({ toolId: "skill.load", args: { skillId: "synax-builtin/visualize" } });
    state.calls.push({ modelToolCallId: call.id });
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
    await select();
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
    state.run.metadata.turnReferenceInputId = "user2";
    expect(presentationDecision("session")).toBeUndefined();
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
    await select({ source: "continuation" });
    expect(pendingPresentationSkillLoads("session")[0].id).not.toBe(call.id);
  });
  it("does not force a preview for text or artifact tasks", async () => {
    for (const mode of ["text", "artifact"]) {
      await select({ mode });
      expect(pendingPresentationSkillLoads("session")).toEqual([]);
      expect(checkPresentationCompletion("session", "Done")).toEqual({ content: "Done" });
    }
  });
  it("retries a missing required preview once, including after re-selection", async () => {
    await select();
    expect(checkPresentationCompletion("session", "Done").retry).toContain("only automatic repair");
    await select();
    const result = checkPresentationCompletion("session", "Done");
    expect(result.retry).toBeUndefined();
    expect(result.content).toContain("交互预览未完成");
    expect(presentationDecision("session")?.status).toBe("failed");
  });
  it("accepts a valid repaired fragment and rejects full documents", async () => {
    await select();
    expect(checkPresentationCompletion("session", "```synax-visualize\n<html>bad</html>\n```").retry).toContain("HTML 片段");
    const content = "```synax-visualize\n<div>chart</div>\n```";
    expect(checkPresentationCompletion("session", content)).toEqual({ content });
    expect(presentationDecision("session")?.status).toBe("validated");
  });
  it("reports unavailable skills without a futile repair", async () => {
    state.skills = [];
    await select();
    expect(pendingPresentationSkillLoads("session")).toEqual([]);
    const result = checkPresentationCompletion("session", "Blocked");
    expect(result.retry).toBeUndefined();
    expect(result.content).toContain("unavailable");
  });
  it("allows optional visuals to fall back to prose", async () => {
    await select({ requirement: "preferred", source: "inferred" });
    expect(checkPresentationCompletion("session", "Explanation")).toEqual({ content: "Explanation" });
  });
  it("honors explicit prohibition and validates incompatible decisions", async () => {
    await select({ mode: "text", requirement: "forbidden" });
    expect(checkPresentationCompletion("session", "Text\n```synax-visualize\n<div>no</div>\n```").content).toBe("Text");
    expect(presentationSchema.safeParse({ mode: "inline_visualization", requirement: "forbidden", source: "explicit", reason: "no" }).success).toBe(false);
  });
});
