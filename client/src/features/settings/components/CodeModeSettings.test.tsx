import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeModeSettings } from "./CodeModeSettings";

describe("Code Mode settings", () => {
  it("starts disabled and saves explicit opt-in with exact MCP IDs", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CodeModeSettings locale="en" onSave={onSave} />);
    const user = userEvent.setup();
    expect(
      screen.getByRole("switch", { name: "Allow read-only composition" }),
    ).not.toBeChecked();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("switch"));
    await user.type(
      screen.getByRole("textbox"),
      "mcp.docs.search\nmcp.docs.search\nmcp.docs.read",
    );
    await user.click(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      mcpTools: ["mcp.docs.search", "mcp.docs.read"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });
  it("rejects wildcards and shows accessible validation errors", async () => {
    const onSave = vi.fn();
    render(
      <CodeModeSettings
        locale="en"
        value={{ enabled: true, mcpTools: [] }}
        onSave={onSave}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "*");
    await user.click(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Wildcards");
    expect(onSave).not.toHaveBeenCalled();
  });
  it("preserves the draft on save failure and permits retry", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    render(<CodeModeSettings locale="zh" onSave={onSave} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch"));
    await user.click(
      screen.getByRole("button", { name: "保存 Agent 能力设置" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("switch")).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "保存 Agent 能力设置" }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  });
  it("disables editing while saving and synchronizes external settings", async () => {
    let finish!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<CodeModeSettings locale="en" onSave={onSave} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch"));
    await user.click(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    );
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    finish();
    await screen.findByRole("status");
    view.rerender(
      <CodeModeSettings
        locale="en"
        value={{ enabled: false, mcpTools: ["mcp.docs.read"] }}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("mcp.docs.read");
  });
});
