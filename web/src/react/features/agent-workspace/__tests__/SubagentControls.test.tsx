import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../../../state/shellStore";
import { SubagentControls } from "../SubagentControls";

const actions = vi.hoisted(() => ({
  cancelSessionRun: vi.fn(),
  deleteSession: vi.fn(),
  fetchChildSessions: vi.fn(),
}));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: { getState: () => actions },
}));
vi.mock("../SessionDeleteDialog", () => ({
  SessionDeleteDialog: ({ isOpen, onConfirm, onClose, isDeleting }: any) =>
    isOpen ? (
      <div role="dialog">
        <button onClick={onConfirm} disabled={isDeleting}>
          Confirm destroy
        </button>
        <button onClick={onClose}>Cancel</button>
      </div>
    ) : null,
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
  it("renders an icon-only destroy button with an accessible name and tooltip", () => {
    render(<SubagentControls {...props} />);
    const button = screen.getByRole("button", { name: "Destroy subagent" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("title")).toBe("Destroy subagent");
    expect(button.querySelector("svg")).not.toBeNull();
  });
  it("stops only the chosen subagent and keeps controls pending until the backend confirms", async () => {
    let finish!: () => void;
    actions.cancelSessionRun.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<SubagentControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }));
    expect(actions.cancelSessionRun).toHaveBeenCalledWith("child");
    expect(
      screen.getByRole("button", { name: "Stop subagent" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Destroy subagent" }),
    ).toBeDisabled();
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull();
    expect(actions.fetchChildSessions).toHaveBeenCalledWith("parent");
  });
  it("requires the destroy dialog before deleting, and cancellation keeps the subagent", async () => {
    render(<SubagentControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Destroy subagent" }));
    expect(actions.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Destroy subagent" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destroy" }));
    await waitFor(() =>
      expect(actions.deleteSession).toHaveBeenCalledWith("child"),
    );
    expect(
      screen.queryByRole("button", { name: "Destroy subagent" }),
    ).toBeNull();
    expect(actions.cancelSessionRun).not.toHaveBeenCalled();
  });
  it("keeps stop available and reports an unconfirmed shutdown error", async () => {
    actions.cancelSessionRun.mockRejectedValue(
      new Error("Shutdown unconfirmed"),
    );
    render(<SubagentControls {...props} />);
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
      render(<SubagentControls {...props} status={status} />);
      expect(
        screen.getByRole("button", { name: "Stop subagent" }),
      ).toBeEnabled();
    },
  );
  it("only offers destroy for a completed child", () => {
    render(<SubagentControls {...props} status="completed" />);
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Destroy subagent" }),
    ).toBeEnabled();
  });
});
