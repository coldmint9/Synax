import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserMessageBlock } from "../UserMessageBlock";
import { useShellStore } from "../../../state/shellStore";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../SessionHistoryContext", () => ({
  useSessionHistory: () => ({
    reason: null,
    busy: false,
    checkpoint: () => ({ id: "checkpoint", available: true }),
    request,
  }),
}));
beforeEach(() => {
  request.mockReset();
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, locale: "en" },
  }));
});
describe("inline message editing", () => {
  it("cancels without modifying the sent message", () => {
    render(<UserMessageBlock messageId="user1" content="Original" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Draft" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps the draft when preview is cancelled and commits only after confirmation", async () => {
    request.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<UserMessageBlock messageId="user1" content="Original" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Edited" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "edit",
        expect.objectContaining({ id: "checkpoint" }),
        "Edited",
      ),
    );
    expect(screen.getByRole("textbox")).toHaveValue("Edited");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and resend" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and resend" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
  });
  it("rejects empty and unchanged drafts and ignores IME submit", () => {
    render(<UserMessageBlock messageId="user1" content="Original" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(
      screen.getByRole("button", { name: "Save and resend" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect(
      screen.getByRole("button", { name: "Save and resend" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "输入" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
