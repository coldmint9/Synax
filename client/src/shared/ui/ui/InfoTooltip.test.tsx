import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoTooltip } from "./InfoTooltip";

describe("supplemental information", () => {
  it("keeps help out of the layout and exposes it with keyboard focus", async () => {
    const user = userEvent.setup();
    const view = render(<InfoTooltip label="About retention">Archives are kept for 7 days.</InfoTooltip>);
    expect(view.container).not.toHaveTextContent("Archives are kept");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Archives are kept for 7 days.");
    expect(screen.getByRole("button")).toHaveAccessibleDescription("Archives are kept for 7 days.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveFocus();
  });

  it("opens on a touch-style click without hover or focus and never submits a form", async () => {
    render(<form><InfoTooltip label="About the shell">Use an absolute path.</InfoTooltip></form>);
    const trigger = screen.getByRole("button", { name: "About the shell" });
    expect(trigger).toHaveAttribute("type", "button");
    fireEvent.click(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Use an absolute path.");
  });
});
