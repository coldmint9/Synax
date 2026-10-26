import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserMessageBlock } from "../UserMessageBlock";
import { useShellStore } from "../../../shared/state/shellStore";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../SessionHistoryContext", () => ({
  useSessionHistory: () => ({
    reason: null,
    busy: false,
    editReason: () => null,
    edit: request,
  }),
}));
beforeEach(() => {
  request.mockReset();
  useShellStore.setState((s) => ({
    preferences: {
      ...s.preferences,
      locale: "en",
      userMessageFontWeight: 450,
    },
  }));
});
describe("inline message editing", () => {
  it("uses the configured weight without changing the edit field", () => {
    const { container } = render(<UserMessageBlock messageId="user1" content="Original" />);
    expect(container.querySelector(".session-user-message")).toHaveStyle({
      fontWeight: "450",
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(screen.getByRole("textbox")).not.toHaveClass("font-semibold");
  });

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
  it("keeps the draft after a failed send and closes only after success", async () => {
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
        "user1",
        "Edited",
      ),
    );
    expect(screen.getByRole("textbox")).toHaveValue("Edited");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
  });
  it("rejects empty drafts but allows unchanged drafts and ignores IME submit", async () => {
    render(<UserMessageBlock messageId="user1" content="Original" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect(
      screen.getByRole("button", { name: "Send" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Original" },
    });
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "user1",
        "Original",
      ),
    );

    request.mockReset();
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


describe("text attachment summaries", () => {
  const raw = "Caused by: example failure\n".repeat(500);
  const parts = [
    { type: "text" as const, text: "Fix startup" },
    { type: "text" as const, text: raw, attachmentName: "pasted.txt" },
    { type: "text" as const, text: "second attachment", attachmentName: "notes.txt" },
  ];

  it("keeps attachment bodies out of the DOM until opened and unmounts them on close", async () => {
    const { container } = render(<UserMessageBlock content={`Fix startup\n${raw}\nsecond attachment`} contentParts={parts} />);
    expect(container.querySelector(".session-user-message")).toHaveTextContent("Fix startup");
    expect(container.textContent).not.toContain("Caused by:");
    expect(container.textContent).not.toContain("second attachment");
    const trigger = screen.getByRole("button", { name: "View original text: pasted.txt" });
    expect(trigger.closest(".session-user-message")).toBeNull();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("pre")?.textContent).toBe(raw);
    expect(dialog.textContent).not.toContain("second attachment");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("Caused by:");
  });

  it("edits only the user input so preserved attachments are not duplicated on resend", async () => {
    request.mockResolvedValue(true);
    render(<UserMessageBlock messageId="user1" content={`Fix startup\n${raw}`} contentParts={parts} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(screen.getByRole("textbox")).toHaveValue("Fix startup");
    expect(screen.getByRole("button", { name: "View original text: pasted.txt" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate startup" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("user1", "Investigate startup"));
  });

  it("renders attachment-only messages without an empty message bubble", () => {
    const { container } = render(<UserMessageBlock content={raw} contentParts={[parts[1]]} />);
    expect(container.querySelector(".session-user-message")).toBeNull();
    expect(screen.getByRole("button", { name: "View original text: pasted.txt" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("Caused by:");
  });

  it("keeps legacy long messages visible without inventing attachment boundaries", () => {
    const { container } = render(<UserMessageBlock content={raw} />);
    expect(container.querySelector(".session-user-message")?.textContent).toBe(raw);
  });
});
