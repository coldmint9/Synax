import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Checkbox, Switch } from "./Toggle";

describe("Headless UI controls", () => {
  it("forwards native button events and ref without submitting forms by default", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button ref={ref} onClick={click}>
          Run
        </Button>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(ref.current).toBe(screen.getByRole("button"));
  });

  it("blocks pending actions, exposes busy state, and does not leak control props", async () => {
    const user = userEvent.setup();
    const click = vi.fn();
    render(
      <Button pending iconOnly onClick={click} aria-label="Save">
        S
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
    for (const prop of ["pending", "icononly", "isPending", "isDisabled"])
      expect(button).not.toHaveAttribute(prop);
  });

  it("exposes typed pending render state without adding duplicate progress glyphs", () => {
    render(
      <Button pending>{({ pending }) => (pending ? "Saving" : "Save")}</Button>,
    );
    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("toggles a switch with Space and submits its name only when checked", async () => {
    const user = userEvent.setup();
    function Form() {
      const [checked, setChecked] = useState(false);
      return (
        <form data-testid="form">
          <Switch
            name="autosave"
            checked={checked}
            onChange={setChecked}
            aria-label="Auto save"
          />
        </form>
      );
    }
    render(<Form />);
    const toggle = screen.getByRole("switch", { name: "Auto save" });
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      new FormData(screen.getByTestId("form") as HTMLFormElement).has(
        "autosave",
      ),
    ).toBe(true);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      new FormData(screen.getByTestId("form") as HTMLFormElement).has(
        "autosave",
      ),
    ).toBe(false);
  });

  it("never changes a disabled switch or checkbox", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(
      <>
        <Switch
          disabled
          checked={false}
          onChange={change}
          aria-label="Switch"
        />
        <Checkbox
          disabled
          checked={false}
          onChange={change}
          aria-label="Checkbox"
        />
      </>,
    );
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("checkbox"));
    expect(change).not.toHaveBeenCalled();
  });

  it("exposes mixed checkbox state and keyboard selection", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(
      <Checkbox
        indeterminate
        checked={false}
        onChange={change}
        aria-label="Select all"
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Select all" });
    expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    checkbox.focus();
    await user.keyboard(" ");
    expect(change).toHaveBeenCalledWith(true);
  });
});
