import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionInvocationUsagePanel } from "../SessionInvocationUsagePanel";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));

afterEach(cleanup);

describe("SessionInvocationUsagePanel", () => {
  it("renders only invoked tools, skills and MCP servers with counts", () => {
    const { container } = render(
      <SessionInvocationUsagePanel
        usage={{
          totalCalls: 8,
          items: [
            { kind: "tool", id: "browser.click", label: "Browser Click", callCount: 3, lastCalledAt: "2026-09-21T01:00:00Z" },
            { kind: "skill", id: "brainstorming", label: "brainstorming", callCount: 1, lastCalledAt: "2026-09-21T02:00:00Z" },
            { kind: "mcp", id: "github", label: "GitHub", callCount: 4, lastCalledAt: "2026-09-21T03:00:00Z" },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("调用统计")).toBeInTheDocument();
    expect(screen.getByText("Browser Click")).toBeInTheDocument();
    expect(screen.getByText("brainstorming")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.getByText("×4")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-invocation-kind]")).toHaveLength(3);
    expect(container.querySelector("svg.lucide-lock")).toBeNull();
    expect(screen.queryByText("0/42")).toBeNull();
  });

  it("omits empty groups", () => {
    const { container } = render(
      <SessionInvocationUsagePanel
        usage={{
          totalCalls: 2,
          items: [
            { kind: "tool", id: "file.read", label: "Read File", callCount: 2, lastCalledAt: "2026-09-21T01:00:00Z" },
          ],
        }}
      />,
    );

    expect(container.querySelector('[data-invocation-kind="tool"]')).not.toBeNull();
    expect(container.querySelector('[data-invocation-kind="skill"]')).toBeNull();
    expect(container.querySelector('[data-invocation-kind="mcp"]')).toBeNull();
  });

  it("shows a zero-call empty state", () => {
    render(<SessionInvocationUsagePanel usage={{ items: [], totalCalls: 0 }} />);
    const panel = screen.getByLabelText("调用统计");
    expect(within(panel).getByText("0 次")).toBeInTheDocument();
    expect(
      within(panel).getByText("本会话尚未调用工具、技能或 MCP。"),
    ).toBeInTheDocument();
  });
});
