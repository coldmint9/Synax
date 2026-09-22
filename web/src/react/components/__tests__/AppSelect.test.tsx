import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AppSelect } from "../AppSelect";

it("uses the HeroUI Select anatomy and changes a single value", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { container } = render(
    <AppSelect
      aria-label="Language"
      value="zh"
      onChange={onChange}
      options={[
        { key: "zh", label: "中文" },
        { key: "en", label: "English" },
      ]}
    />,
  );

  const trigger = screen.getByRole("button", { name: /Language/ });
  expect(trigger).toHaveAttribute("data-slot", "select-trigger");
  expect(
    container.querySelector('[data-slot="select-default-indicator"]'),
  ).not.toBeNull();
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "English" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("en");
});

it("preserves disabled options", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <AppSelect
      aria-label="Workspace"
      value="ready"
      onChange={onChange}
      options={[
        { key: "ready", label: "Ready" },
        { key: "missing", label: "Missing", isDisabled: true },
      ]}
    />,
  );

  await user.click(screen.getByRole("button", { name: /Workspace/ }));
  const missing = await screen.findByRole("option", { name: "Missing" });
  expect(missing).toHaveAttribute("aria-disabled", "true");
  await user.click(missing);
  expect(onChange).not.toHaveBeenCalled();
});
