import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { SessionProfilePanel } from "../SessionProfilePanel";
import { SessionSystemPromptPanel } from "../SessionSystemPromptPanel";
import type { AgentSession } from "../../../../lib/api/agentRuntime";

function session(
  id: string,
  prompt?: string,
  backend = "native",
): AgentSession {
  return {
    id,
    prompt: "USER_INPUT_MUST_NOT_BE_A_SYSTEM_PROMPT",
    model: null,
    sessionMetadata: { backend: { id: backend }, latestSystemPrompt: prompt },
  } as AgentSession;
}

describe("SessionProfilePanel", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessions: [],
      selectedSessionId: null,
      detailLoading: false,
      sessionStats: null,
      sessionTodos: [],
      sessionCapabilities: null,
      steps: [],
    });
  });

  afterEach(() => cleanup());

  it("discloses runtime details only on demand", () => {
    render(<SessionProfilePanel sessionId="session-1" />);

    const toggle = screen.getByRole("button", { name: "运行详情" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("does not show an inspector without a session", () => {
    render(<SessionProfilePanel sessionId={null} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the requested session preview rather than the globally selected session", () => {
    useAgentSessionStore.setState({
      sessions: [session("one", "SYSTEM_ONE"), session("two", "SYSTEM_TWO")],
      selectedSessionId: "two",
    });
    render(<SessionProfilePanel sessionId="one" />);
    fireEvent.click(screen.getByRole("button", { name: "运行详情" }));
    const toggle = screen.getByRole("button", { name: "最近组装的系统提示词" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("SYSTEM_ONE")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("SYSTEM_ONE")).toBeInTheDocument();
    expect(screen.queryByText("SYSTEM_TWO")).toBeNull();
    expect(
      screen.getByText("此预览不包含完整对话、工具定义和尾部运行状态。"),
    ).toBeInTheDocument();
  });

  it("shows an empty state without substituting user input and folds on session changes", () => {
    const view = render(<SessionSystemPromptPanel session={session("one")} />);
    fireEvent.click(
      screen.getByRole("button", { name: "最近组装的系统提示词" }),
    );
    expect(screen.getByText("尚未生成")).toBeInTheDocument();
    expect(
      screen.queryByText("USER_INPUT_MUST_NOT_BE_A_SYSTEM_PROMPT"),
    ).toBeNull();
    view.rerender(
      <SessionSystemPromptPanel session={session("two", "SYSTEM_TWO")} />,
    );
    expect(
      screen.getByRole("button", { name: "最近组装的系统提示词" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("SYSTEM_TWO")).toBeNull();
  });

  it.each(["codex", "claude-code", "codex-acp"])(
    "does not show a native preview for %s",
    (backend) => {
      render(
        <SessionSystemPromptPanel
          session={session("external", "STALE_SYSTEM", backend)}
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText("STALE_SYSTEM")).toBeNull();
    },
  );
});
