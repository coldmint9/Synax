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
import type {
  AgentSession,
  SessionStats,
} from "../../../../lib/api/agentRuntime";

function session(id: string): AgentSession {
  return {
    id,
    prompt: "USER_INPUT_MUST_NOT_BE_A_SYSTEM_PROMPT",
    model: null,
    sessionMetadata: { backend: { id: "native" } },
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
      sessionInvocationUsage: null,
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

  it("keeps status in the header without repeating context or elapsed time there", () => {
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
    expect(header.queryByText(/上下文/)).toBeNull();
    expect(container.textContent).not.toContain("≈");
    expect(header.getByText("completed")).toBeInTheDocument();
    expect(header.queryByText("1:05")).toBeNull();
    expect(header.queryByText("运行详情")).toBeNull();
    fireEvent.click(header.getByRole("button", { name: "运行详情" }));
    expect(screen.getAllByText("completed")).toHaveLength(1);
    expect(screen.queryByText("1:05")).toBeNull();
    expect(screen.getByText("上下文组成")).toBeInTheDocument();
  });


  it("shows invocation usage instead of the capability inventory", () => {
    localStorage.removeItem("synax:workspace:disclosure:usage:runtime");
    useAgentSessionStore.setState({
      selectedSessionId: "usage",
      sessions: [session("usage")],
      sessionInvocationUsage: {
        totalCalls: 3,
        items: [
          {
            kind: "tool",
            id: "browser.click",
            label: "Browser Click",
            callCount: 3,
            lastCalledAt: "2026-09-21T00:00:00Z",
          },
        ],
      },
    });

    render(<SessionProfilePanel sessionId="usage" />);
    fireEvent.click(screen.getByRole("button", { name: "运行详情" }));
    expect(screen.getByText("调用统计")).toBeInTheDocument();
    expect(screen.getByText("Browser Click")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.queryByText("0/42")).toBeNull();
  });

  it("does not show an inspector without a session", () => {
    render(<SessionProfilePanel sessionId={null} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

});
