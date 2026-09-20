import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionBackendPicker } from "../SessionBackendPicker";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en" }),
}));
const options = [
  { id: "native" as const, label: "Synax Native" },
  { id: "codex-acp" as const, label: "Codex ACP" },
];

describe("SessionBackendPicker", () => {
  it("selects an execution backend explicitly", async () => {
    const onChange = vi.fn();
    render(
      <SessionBackendPicker
        value="native"
        options={options}
        disabled={false}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Execution backend" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Codex ACP" }),
    );
    expect(onChange).toHaveBeenCalledWith("codex-acp");
  });
  it("keeps existing session bindings immutable", () => {
    render(
      <SessionBackendPicker
        value="native"
        options={options}
        disabled
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Execution backend" }),
    ).toBeDisabled();
  });
});
