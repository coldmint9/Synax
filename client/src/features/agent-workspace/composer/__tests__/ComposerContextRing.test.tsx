import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ContextUsageSnapshot } from "../../../../adapters/transport/agentRuntime";
import { ComposerContextRing } from "../ComposerContextRing";
import { useShellStore } from "../../../../shared/state/shellStore";

const usage: ContextUsageSnapshot = {
  version: 1,
  source: "provider",
  stepId: "step-1",
  total: 1200,
  limit: 2400,
  measuredAt: "2026-10-22T10:00:00.000Z",
  composition: {
    version: 2,
    messages: 600,
    tools: 300,
    mcp: 50,
    skills: 50,
    system: 200,
    total: 1200,
    measuredAt: "2026-10-22T10:00:00.000Z",
  },
};

describe("ComposerContextRing", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
  });

  it("renders nothing before a context measurement exists", () => {
    const { container } = render(<ComposerContextRing usage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows only the provider-measured usage on hover", async () => {
    const user = userEvent.setup();
    render(<ComposerContextRing usage={usage} />);
    const button = screen.getByRole("button", { name: /上下文占用 50%/ });
    expect(button).toBeInTheDocument();

    await user.hover(button);
    const panel = await screen.findByRole("tooltip");
    await waitFor(() =>
      expect(within(panel).getByText("1.2K / 2400")).toBeInTheDocument(),
    );
    expect(within(panel).getByText("50%")).toBeInTheDocument();
    expect(within(panel).getByText(/服务商实测输入/)).toBeInTheDocument();
    // No locally estimated category numbers are presented as context usage.
    expect(within(panel).queryByText("消息")).toBeNull();
    expect(within(panel).queryByText("工具")).toBeNull();
    expect(within(panel).queryByText("600")).toBeNull();
    expect(within(panel).queryByText(/tokens\/s/)).toBeNull();
  });

  it("marks near-full windows with the warning tone", () => {
    const { container } = render(
      <ComposerContextRing usage={{ ...usage, total: 2300 }} />,
    );
    expect(
      container
        .querySelector(".composer-context-ring__value")
        ?.getAttribute("data-tone"),
    ).toBe("danger");
  });

});
