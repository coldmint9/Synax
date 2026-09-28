import { createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";
import { Button } from "./Button";

describe("floating tooltips", () => {
  it("never renders hint text inline, and only mounts it after hover", async () => {
    const user = userEvent.setup();
    const view = render(
      <Tooltip content="Copy message" delay={40}>
        <Button aria-label="Copy">◎</Button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("Copy message");
    await user.hover(screen.getByRole("button", { name: "Copy" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Copy message");
    expect(view.container).not.toContainElement(tooltip);
    await user.unhover(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });
  it("opens on keyboard focus, associates its description, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Fork from this message">
        <Button aria-label="Fork">⑂</Button>
      </Tooltip>,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Fork" });
    const tooltip = await screen.findByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(trigger).toHaveAccessibleDescription("Fork from this message");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("preserves refs and click handlers without adding a nested button", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    render(
      <Tooltip content="Run">
        <Button ref={ref} onClick={click}>
          Run
        </Button>
      </Tooltip>,
    );
    await user.click(screen.getByRole("button"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(screen.getByRole("button"));
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("describes unavailable actions without making them actionable", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="No checkpoint">
        <Button aria-label="Rollback" aria-disabled>
          ↶
        </Button>
      </Tooltip>,
    );
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "No checkpoint",
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
  });
});
