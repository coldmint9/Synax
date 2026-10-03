import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

const options = [
  { value: "one", label: "One" },
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "two", label: "Two" },
];
describe("Headless selection", () => {
  it("does not announce a visible field label twice", () => {
    render(<Select label="Protocol" aria-label="Protocol" value="one" options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Protocol" })).toHaveTextContent("One");
  });

  it("navigates by keyboard, skips disabled entries and restores focus", async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState<string | null>("one");
      return (
        <Select
          label="Model"
          value={value}
          onChange={setValue}
          options={options}
        />
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Model" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard(" ");
    const listbox = await screen.findByRole("listbox");
    await waitFor(() =>
      expect(listbox).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: "One" }).id,
      ),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(listbox).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: "Two" }).id,
      ),
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Model" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Two",
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
  it("supports null selection and shows the selected rich label rather than a raw id", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(
      <Select
        aria-label="Workspace"
        value={null}
        onChange={change}
        placeholder="Choose"
        options={[
          {
            value: "opaque-id",
            label: <strong>Project name</strong>,
            textValue: "Project name",
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Workspace" }));
    await user.click(screen.getByRole("option", { name: "Project name" }));
    expect(change).toHaveBeenCalledWith("opaque-id");
  });
  it("does not open while disabled", async () => {
    const user = userEvent.setup();
    render(
      <Select
        aria-label="Model"
        value="one"
        onChange={vi.fn()}
        options={options}
        disabled
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
