import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { SessionProfilePanel } from "../SessionProfilePanel";
import { SessionSystemPromptPanel } from "../SessionSystemPromptPanel";
import type {
  AgentSession,
  SessionStats,
} from "../../../../lib/api/agentRuntime";

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

  it("keeps current context, status and elapsed time in the header without duplicating them on expansion", () => {
    localStorage.removeItem("synax:workspace:disclosure:metrics:runtime");
    useAgentSessionStore.setState({
      selectedSessionId: "metrics",
      sessions: [{ ...session("metrics"), status: "completed" }],
      sessionStats: {
        status: "running",
        runningDuration: 65000,
        roundCount: 2,
        context: {
          inputTokens: 12500,
          source: "provider",
          latestRequestUsageAvailable: true,
        },
        contextLimit: 100000,
        activeSubAgentCount: 0,
      } as SessionStats,
    });
    const { container } = render(<SessionProfilePanel sessionId="metrics" />);
    const header = within(
      container.querySelector<HTMLElement>(".ws-card-head")!,
    );
    expect(header.getByText("上下文 12.5K")).toBeInTheDocument();
    expect(header.getByText("completed")).toBeInTheDocument();
    expect(header.getByText("1:05")).toBeInTheDocument();
    fireEvent.click(header.getByRole("button", { name: "运行详情" }));
    expect(screen.getAllByText("completed")).toHaveLength(1);
    expect(screen.getAllByText("1:05")).toHaveLength(1);
    expect(header.getByText("上下文 12.5K")).toBeInTheDocument();
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
