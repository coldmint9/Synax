import { describe, expect, it } from "vitest";
import { subagentTaskTitle } from "../subagentTaskTitle";

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
});
