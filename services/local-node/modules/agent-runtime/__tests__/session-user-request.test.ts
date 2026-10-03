import { describe, expect, it } from "vitest";
import { buildSessionPrompt } from "../session-prompt.js";
import {
  buildSessionUserMessage,
  resolveSessionUserRequest,
  initialSessionMessageProjection,
} from "../session-user-request.js";
import { synaxAgent } from "../synax/synax-agent.js";

describe("session initialization intent boundary", () => {
  it.each([
    "你好",
    "plan 模式真的有效吗？",
    "调查列表过滤逻辑",
    "修改会话列表，隐藏子会话",
  ])("keeps the original user request: %s", (content) => {
    expect(
      buildSessionPrompt({
        mode: "session",
        content,
        locale: "zh",
      }),
    ).toBe(content);
  });
  it("uses canonical metadata to preserve the original request during initial routing", () => {
    const prompt = buildSessionPrompt({
      content: "Old request",
    });
    const session = {
      prompt,
      sessionMetadata: {
        source: "session-page",
        userPrompt: "Current request",
        goalContent: "Old request",
      },
    };
    expect(resolveSessionUserRequest(session, prompt)).toBe("Current request");
    expect(resolveSessionUserRequest(session, "Follow-up request")).toBe(
      "Follow-up request",
    );
    expect(initialSessionMessageProjection(session)?.content).toBe(
      "Current request",
    );
  });
  it("routes the first message by user intent even when legacy scaffolding or reference titles contain coding words", () => {
    const prompt = buildSessionPrompt({
      content: "请调查认证",
    });
    const session = {
      profileId: "synax",
      prompt,
      sessionMetadata: {
        mode: "chat",
        source: "session-page",
        goalContent: "请调查认证",
      },
    };
    expect(synaxAgent.buildIntentPromptSection(session, prompt)).toContain(
      "Investigate and explain",
    );
    expect(synaxAgent.buildIntentPromptSection(session, prompt)).not.toContain(
      "Implement the requested change",
    );
    expect(resolveSessionUserRequest(session, "修复认证")).toBe("修复认证");
    expect(initialSessionMessageProjection(session)?.content).toBe(
      "请调查认证",
    );
  });
  it("never strips arbitrary user Markdown or PlanNode workflow prompts", () => {
    const text =
      "## User Goal\nExplain\n\n## Instructions\nKeep this exact instruction";
    expect(
      resolveSessionUserRequest({ prompt: text, sessionMetadata: {} }, text),
    ).toBe(text);
    expect(
      initialSessionMessageProjection({
        prompt: text,
        sessionMetadata: { source: "goal-dock", goalContent: "Explain" },
      }),
    ).toBeUndefined();
    const direct = buildSessionPrompt({
      mode: "direct",
      content: "Implement it",
    });
    expect(direct).toContain("implement the goal");
    expect(
      buildSessionPrompt({
        mode: "plan_node",
        content: "Bounded node",
        node: {
          title: "Node",
          description: "Do this only",
          expectedFiles: ["a.ts"],
          dependsOn: [],
        },
      }),
    ).toContain("Do this only");
  });
});
