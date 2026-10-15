import { describe, expect, it } from "vitest";
import { subagentTaskTitle } from "../subagentTaskTitle";

const EXPLORER_PLAYBOOK = [
  "## Explorer Playbook",
  "Investigate the assigned question read-only. Do not implement changes or delegate it again.",
  "Return concise findings, evidence references and unresolved gaps.",
].join("\n");

describe("subagentTaskTitle", () => {
  it("shows the delegated exploration task instead of the injected context", () => {
    expect(subagentTaskTitle({
      title: "## Subagent delegation context",
      prompt: "## Subagent delegation context\nYou are 小雨.\n\n## Delegated task\n探索缓存失效的原因\n检查相关调用。",
      profileId: "explorer",
    })).toBe("探索缓存失效的原因");
  });

  it("preserves a real title", () => {
    expect(subagentTaskTitle({ title: "探索任务", prompt: "内部说明" })).toBe("探索任务");
  });

  it("supports plain prompts and incomplete historical envelopes", () => {
    expect(subagentTaskTitle({ prompt: "查找入口\n更多细节" })).toBe("查找入口");
    expect(subagentTaskTitle({ prompt: "## Subagent delegation context", profileId: "explorer" })).toBe("探索任务");
  });

  it("skips the explorer wrapper sections and reports the investigation itself", () => {
    const prompt = [
      "## Subagent delegation context",
      "You are 明澈.",
      "Your role is 探索员.",
      "",
      "## Delegated task",
      "## Investigation Task",
      "检查卡片头部的状态表达是否重复",
      "",
      EXPLORER_PLAYBOOK,
    ].join("\n");
    expect(subagentTaskTitle({ prompt, profileId: "explorer", title: null }))
      .toBe("检查卡片头部的状态表达是否重复");
  });

  it("never surfaces the wrapper heading alone", () => {
    const prompt = [
      "## Investigation Task",
      "梳理子代理卡片布局",
      "",
      EXPLORER_PLAYBOOK,
    ].join("\n");
    expect(subagentTaskTitle({ prompt, profileId: "explorer" })).toBe("梳理子代理卡片布局");
    expect(subagentTaskTitle({
      prompt: ["## Delegated task", "## Investigation Task", EXPLORER_PLAYBOOK].join("\n"),
      profileId: "explorer",
    })).toBe("探索任务");
  });

  it("cleans a persisted title that still carries the wrapper", () => {
    expect(subagentTaskTitle({
      title: "## Investigation Task\n核对状态点文案",
      prompt: "",
      profileId: "explorer",
    })).toBe("核对状态点文案");
  });
});
