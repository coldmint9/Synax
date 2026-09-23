import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ContextMenuProvider, useContextMenu } from "../ContextMenuProvider";

function Target({ run = () => {} }: { run?: () => void }) {
  const menu = useContextMenu(() => ({ label: "Test actions", entries: [
    { type: "action", id: "open", label: "Open target", run },
    { type: "separator" },
    { type: "action", id: "remove", label: "Remove target", danger: true, run },
  ] }));
  return <><button type="button" onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown} aria-haspopup="menu">Target</button><input aria-label="Edit" /></>;
}

function setup(run = vi.fn()) {
  return { run, ...render(<MemoryRouter><ContextMenuProvider><Target run={run} /></ContextMenuProvider></MemoryRouter>) };
}

afterEach(() => { Reflect.deleteProperty(window, "electronAPI"); });

describe("context menu renderer", () => {
  it("correlates native action callbacks with the current menu request", async () => {
    let onAction: ((requestId: string, actionId: string) => void) | undefined;
    let onClosed: ((requestId: string) => void) | undefined;
    const showContextMenu = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: {
      showContextMenu,
      onContextMenuAction: (callback: typeof onAction) => { onAction = callback; return () => {}; },
      onContextMenuClosed: (callback: typeof onClosed) => { onClosed = callback; return () => {}; },
    } });
    const { run } = setup();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Target" }), { clientX: 5, clientY: 9 });
    await waitFor(() => expect(showContextMenu).toHaveBeenCalledOnce());
    const request = showContextMenu.mock.calls[0][0];
    expect(request.entries[0]).toMatchObject({ type: "action", id: "open", label: "Open target" });
    expect(request.entries[0]).not.toHaveProperty("run");
    onAction?.("previous-request", "open");
    onAction?.(request.requestId, "unknown");
    expect(run).not.toHaveBeenCalled();
    onAction?.(request.requestId, "open");
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    onClosed?.(request.requestId);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("opens at right click, selects one command and closes", async () => {
    const { run } = setup();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Target" }), { clientX: 17, clientY: 23 });
    expect(await screen.findByRole("menu", { name: "Test actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test actions" }).style.left).toBe("17px");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open target" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });
  it("opens from Shift+F10 and leaves text editing native", async () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Edit" });
    expect(fireEvent.contextMenu(input)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Target" }), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Test actions" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Test actions" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Target" })));
  });
});
