import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeModeSettings } from "./CodeModeSettings";

describe("Code Mode settings", () => {
  it("shows native composition as enabled by default and saves exact MCP IDs", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CodeModeSettings locale="en" onSave={onSave} />);
    const user = userEvent.setup();

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/enabled by default/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    ).toBeDisabled();
    await user.type(
      screen.getByRole("textbox"),
      "mcp.docs.search\nmcp.docs.search\nmcp.docs.read",
    );
    await user.click(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      mcpTools: ["mcp.docs.search", "mcp.docs.read"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("accepts legacy enabled input without exposing or saving the switch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CodeModeSettings
        locale="en"
        value={{ enabled: false, mcpTools: ["mcp.docs.read"] }}
        onSave={onSave}
      />,
    );
    const user = userEvent.setup();

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "\nmcp.docs.search");
    await user.click(
      screen.getByRole("button", { name: "Save agent capability settings" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      mcpTools: ["mcp.docs.read", "mcp.docs.search"],
    });
  });

  it("rejects wildcards and shows accessible validation errors", async () => {
    const onSave = vi.fn();
    render(<CodeModeSettings locale="en" onSave={onSave} />);
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
    await user.type(screen.getByRole("textbox"), "mcp.docs.read");
    await user.click(
      screen.getByRole("button", { name: "保存 Agent 能力设置" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("textbox")).toHaveValue("mcp.docs.read");
    await user.click(
      screen.getByRole("button", { name: "保存 Agent 能力设置" }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  });
});
