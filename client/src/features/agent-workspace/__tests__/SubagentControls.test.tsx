import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useShellStore } from "../../../shared/state/shellStore";
import { SubagentControls } from "../SubagentControls";

const actions = vi.hoisted(() => ({
  cancelSessionRun: vi.fn(),
  deleteSession: vi.fn(),
  fetchChildSessions: vi.fn(),
}));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: { getState: () => actions },
}));
const props = {
  sessionId: "child",
  parentSessionId: "parent",
  status: "running" as const,
  title: "Inspect files",
};

describe("SubagentControls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
  });
  it("renders an icon-only archive button with an accessible name and tooltip", () => {
    render(<MemoryRouter><SubagentControls {...props} /></MemoryRouter>);
    const button = screen.getByRole("button", { name: "Archive subagent" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("title")).toBe("Archive subagent");
    expect(button.querySelector("svg")).not.toBeNull();
  });
  it("stops only the chosen subagent and keeps controls pending until the backend confirms", async () => {
    let finish!: () => void;
    actions.cancelSessionRun.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<MemoryRouter><SubagentControls {...props} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }));
    expect(actions.cancelSessionRun).toHaveBeenCalledWith("child");
    expect(
      screen.getByRole("button", { name: "Stop subagent" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Archive subagent" }),
    ).toBeDisabled();
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull();
    expect(actions.fetchChildSessions).toHaveBeenCalledWith("parent");
  });
  it("archives immediately without a confirmation dialog", async () => {
    actions.deleteSession.mockResolvedValue(["child"]);
    render(<MemoryRouter><SubagentControls {...props} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Archive subagent" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.deleteSession).toHaveBeenCalledWith("child", expect.any(Function));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Archive subagent" })).toBeNull());
    expect(actions.cancelSessionRun).not.toHaveBeenCalled();
  });
  it("keeps stop available and reports an unconfirmed shutdown error", async () => {
    actions.cancelSessionRun.mockRejectedValue(
      new Error("Shutdown unconfirmed"),
    );
    render(<MemoryRouter><SubagentControls {...props} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Shutdown unconfirmed",
    );
    expect(screen.getByRole("button", { name: "Stop subagent" })).toBeEnabled();
    expect(actions.fetchChildSessions).not.toHaveBeenCalled();
  });
  it.each(["queued", "waiting_input", "waiting_permission"] as const)(
    "allows stopping a %s child",
    (status) => {
      render(<MemoryRouter><SubagentControls {...props} status={status} /></MemoryRouter>);
      expect(
        screen.getByRole("button", { name: "Stop subagent" }),
      ).toBeEnabled();
    },
  );
  it("only offers archive for a completed child", () => {
    render(<MemoryRouter><SubagentControls {...props} status="completed" /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Archive subagent" }),
    ).toBeEnabled();
  });
});
