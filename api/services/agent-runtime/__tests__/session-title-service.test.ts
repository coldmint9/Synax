import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  resolveInitialSessionTitle,
  shortSessionTitle,
  generateSessionTitle,
  scheduleSessionTitleAfterRunStart,
  maybeScheduleSessionTitleFromStreamChunk,
  ensureSessionTitleGenerated,
  isValidGeneratedSessionTitle,
  needsGeneratedSessionTitle,
  registerSessionTitleHooks,
} from "../session-title-service.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { sessionHooks } from "../session-hooks.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { nowIso, resetRuntimeIdsForTests } from "../runtime-ids.js";

vi.mock("../../llm-runtime/gateway.js", () => ({
  generateGatewayTextResult: vi.fn(),
}));

import { generateGatewayTextResult } from "../../llm-runtime/gateway.js";

const LONG_INPUT =
  "请帮助我完整分析当前项目里的用户认证模块实现，检查潜在漏洞、完善错误处理并补充必要的回归测试。";
const mockGenerateGatewayTextResult = vi.mocked(generateGatewayTextResult);

describe("resolveInitialSessionTitle", () => {
  it("uses short user input immediately for agent page draft sessions", () => {
    expect(
      resolveInitialSessionTitle({
        sessionMetadata: {
          source: "session-page",
          goalContent: "帮我看看认证模块",
        },
        prompt: "帮我看看认证模块",
      }),
    ).toBe("帮我看看认证模块");
  });

  it.each(["agent-dock", "goal-dock"])(
    "counts short titles by Unicode code points and defers long %s requests",
    (source) => {
      expect(shortSessionTitle("😀".repeat(40))).toBe("😀".repeat(40));
      expect(shortSessionTitle("😀".repeat(41))).toBeNull();
      expect(shortSessionTitle("x".repeat(100_000))).toBeNull();
      expect(
        resolveInitialSessionTitle({
          sessionMetadata: { source, userPrompt: LONG_INPUT },
          prompt: LONG_INPUT,
        }),
      ).toBe("new session");
    },
  );

  it("uses goalContent from session metadata", () => {
    expect(
      resolveInitialSessionTitle({
        sessionMetadata: { goalContent: "你好，帮我看看认证模块" },
        prompt: "## User Goal\nIgnored",
      }),
    ).toBe("你好，帮我看看认证模块");
  });

  it("truncates long user input", () => {
    const long = "a".repeat(100);
    const title = resolveInitialSessionTitle({
      sessionMetadata: { goalContent: long },
      prompt: "",
    });
    expect(title).toHaveLength(80);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("uses short non-system prompts as provisional titles", () => {
    expect(
      resolveInitialSessionTitle({
        sessionMetadata: null,
        prompt: "Plan a bounded implementation slice.",
      }),
    ).toBe("Plan a bounded implementation slice.");
  });

  it("skips long system-style prompts without extractable goal", () => {
    expect(
      resolveInitialSessionTitle({
        sessionMetadata: null,
        prompt: "You are a Goal Agent\n\n## Instructions\nDo things",
      }),
    ).toBeNull();
  });
});

describe("session title after first run", () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
    mockGenerateGatewayTextResult.mockReset();
    mockGenerateGatewayTextResult.mockResolvedValue({
      text: "问候用户",
    } as Awaited<ReturnType<typeof generateGatewayTextResult>>);
  });

  it("does not overwrite another session when independent ID sequences start in the same millisecond", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1789572810000);
    try {
      resetRuntimeIdsForTests();
      const first = agentSessionRuntime.create({
        projectId: "project-alpha",
        profileId: "synax",
        prompt: "First request",
        sessionMetadata: {
          source: "session-page",
          goalContent: "First request",
        },
      });
      resetRuntimeIdsForTests();
      const second = agentSessionRuntime.create({
        projectId: "project-alpha",
        profileId: "synax",
        prompt: "Second request",
        sessionMetadata: {
          source: "session-page",
          goalContent: "Second request",
        },
      });
      expect(second.id).not.toBe(first.id);
      expect(agentRuntimeStore.getSession(first.id).title).toBe(
        "First request",
      );
      expect(agentRuntimeStore.getSession(second.id).title).toBe(
        "Second request",
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("uses short inputs across parallel sessions without any model requests", async () => {
    const sessions = ["修复登录", "Fix billing", "调试网络"].map((prompt) =>
      agentSessionRuntime.create({
        projectId: "project-alpha",
        profileId: "synax",
        prompt,
        sessionMetadata: { source: "session-page", goalContent: prompt },
      }),
    );
    for (const session of sessions) ensureSessionTitleGenerated(session.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      sessions.map((session) => agentRuntimeStore.getSession(session.id).title),
    ).toEqual(["修复登录", "Fix billing", "调试网络"]);
    expect(mockGenerateGatewayTextResult).not.toHaveBeenCalled();
  });

  it("binds out-of-order model results to their original session and preserves manual renames", async () => {
    const resolves: Array<(value: any) => void> = [];
    mockGenerateGatewayTextResult.mockImplementation(
      () => new Promise((resolve) => resolves.push(resolve)),
    );
    const sessions = ["A", "B", "C"].map((suffix) =>
      agentSessionRuntime.create({
        projectId: "project-alpha",
        profileId: "synax",
        prompt: LONG_INPUT + suffix,
        sessionMetadata: {
          source: "session-page",
          goalContent: LONG_INPUT + suffix,
        },
      }),
    );
    sessions.forEach((session) => ensureSessionTitleGenerated(session.id));
    await vi.waitFor(() => expect(resolves).toHaveLength(3));
    agentRuntimeStore.updateSession(sessions[2].id, { title: "我的标题" });
    resolves[2]({ text: "第三标题" });
    resolves[1]({ text: "第二标题" });
    resolves[0]({ text: "第一标题" });
    await vi.waitFor(() =>
      expect(
        sessions.map(
          (session) => agentRuntimeStore.getSession(session.id).title,
        ),
      ).toEqual(["第一标题", "第二标题", "我的标题"]),
    );
  });

  it("generates the title on run_started while the first turn is still running", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });
    expect(session.title).toBe("new session");

    const run = agentRuntimeStore.appendRun({
      id: "run_title_test",
      sessionId: session.id,
      status: "running",
      triggerMessageId: null,
      startedAt: nowIso(),
      completedAt: null,
      stopReason: null,
      model: null,
      currentStep: 0,
      metadata: {},
    });

    agentRuntimeStore.updateSession(session.id, { activeRunId: run.id });
    maybeScheduleSessionTitleFromStreamChunk(session.id, {
      type: "run_started",
      run,
    });

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
  });

  it.each(["new agent", "  NEW AGENT  ", "new chat", "新对话"])("still summarizes sessions left with placeholder %s", async (title) => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });
    agentRuntimeStore.updateSession(session.id, { title });

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
  });

  it("does not mistake a custom title mentioning new agent for a placeholder", () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
    });
    for (const title of ["Build a new agent", "new agent design"]) {
      expect(needsGeneratedSessionTitle({ ...session, title })).toBe(false);
    }
    expect(needsGeneratedSessionTitle({
      ...session,
      title: "new agent",
      sessionMetadata: { titleSummarized: true },
    })).toBe(false);
  });

  it("scheduleSessionTitleAfterRunStart generates title for placeholder sessions", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    const run = agentRuntimeStore.appendRun({
      id: "run_direct_title",
      sessionId: session.id,
      status: "running",
      triggerMessageId: null,
      startedAt: nowIso(),
      completedAt: null,
      stopReason: null,
      model: null,
      currentStep: 0,
      metadata: {},
    });

    scheduleSessionTitleAfterRunStart(session.id, run.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
  });

  it("generateSessionTitle summarizes long synax requests", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    await generateSessionTitle(
      session.id,
      session.projectId,
      session.profileId,
      session.prompt,
    );

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
    expect(mockGenerateGatewayTextResult).toHaveBeenCalled();
  });

  it("ensureSessionTitleGenerated updates placeholder title after stream", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });
    expect(session.title).toBe("new session");

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
    expect(mockGenerateGatewayTextResult).toHaveBeenCalled();
  });

  it("falls back to user input when LLM returns empty text", async () => {
    mockGenerateGatewayTextResult.mockResolvedValue({ text: "" } as Awaited<
      ReturnType<typeof generateGatewayTextResult>
    >);
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe(LONG_INPUT);
    });
    expect(
      agentRuntimeStore.getSession(session.id).sessionMetadata?.titleSummarized,
    ).toBe(true);
  });

  it("falls back to truncated user input when LLM title fails validation", async () => {
    mockGenerateGatewayTextResult.mockResolvedValue({
      text: "This is a much too long English title that should never pass validation",
    } as Awaited<ReturnType<typeof generateGatewayTextResult>>);
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe(LONG_INPUT);
    });
  });
  it("coalesces repeated triggers into a single generation call", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    ensureSessionTitleGenerated(session.id);
    ensureSessionTitleGenerated(session.id);
    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
    // Allow any queued re-check to settle before asserting the call count.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockGenerateGatewayTextResult).toHaveBeenCalledTimes(1);
  });

  it("defers generation out of the caller stack instead of blocking it", () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });

    const startedAt = Date.now();
    ensureSessionTitleGenerated(session.id);
    // The scheduling call must return immediately, before any LLM work starts.
    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(mockGenerateGatewayTextResult).not.toHaveBeenCalled();
  });

  it("waits for an in-flight run before generating the title", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });
    agentRuntimeStore.updateSession(session.id, {
      activeRunId: "run_active_title",
    });

    ensureSessionTitleGenerated(session.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockGenerateGatewayTextResult).not.toHaveBeenCalled();
    expect(agentRuntimeStore.getSession(session.id).title).toBe("new session");

    agentRuntimeStore.updateSession(session.id, { activeRunId: null });
    ensureSessionTitleGenerated(session.id);
    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
  });
  it("generates the title when a run completes (parent-process hook)", async () => {
    registerSessionTitleHooks();
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: LONG_INPUT,
      sessionMetadata: {
        mode: "goal",
        source: "session-page",
        goalContent: LONG_INPUT,
      },
    });
    agentRuntimeStore.updateSession(session.id, {
      activeRunId: "run_hook_title",
    });

    await sessionHooks.emit({
      type: "run:completed",
      sessionId: session.id,
      runId: "run_hook_title",
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockGenerateGatewayTextResult).not.toHaveBeenCalled();

    agentRuntimeStore.updateSession(session.id, { activeRunId: null });
    await sessionHooks.emit({
      type: "run:completed",
      sessionId: session.id,
      runId: "run_hook_title",
      status: "completed",
    });
    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe("问候用户");
    });
  });
});

describe("isValidGeneratedSessionTitle", () => {
  it("accepts short Chinese titles", () => {
    expect(isValidGeneratedSessionTitle("问候用户")).toBe(true);
  });

  it("accepts short English titles", () => {
    expect(isValidGeneratedSessionTitle("Fix auth module")).toBe(true);
  });

  it("rejects overly long English titles", () => {
    expect(
      isValidGeneratedSessionTitle("one two three four five six seven"),
    ).toBe(false);
  });

  it("rejects overly long Chinese titles", () => {
    expect(isValidGeneratedSessionTitle("一二三四五六七八九十甲")).toBe(false);
  });
});
