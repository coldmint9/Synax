import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UserMessageBlock } from "../UserMessageBlock";
import { useShellStore } from "../../../shared/state/shellStore";

vi.mock("../SessionHistoryContext", () => ({
  useSessionHistory: () => ({
    reason: null,
    busy: false,
    editReason: () => null,
    edit: vi.fn(),
  }),
}));

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: {
      ...state.preferences,
      locale: "en",
      userMessageFontWeight: 450,
    },
  }));
});

const references = [
  { kind: "skill" as const, id: "code-review", label: "Code review" },
  { kind: "file" as const, id: "src/parser.ts" },
];

describe("turn references on a sent message", () => {
  it("renders them separated below the message bubble", () => {
    const { container } = render(
      <UserMessageBlock content="Review the parser" references={references} />,
    );
    const bubble = container.querySelector(".session-user-message")!;
    const tags = screen.getByRole("list", {
      name: "References for this message",
    });

    expect(bubble).toHaveTextContent("Review the parser");
    expect(bubble.contains(tags)).toBe(false);
    expect(tags).toHaveTextContent("Skill · Code review");
    expect(tags).toHaveTextContent("File · src/parser.ts");
    // Below the bubble, not around it: the readable order puts the message first.
    const text = container.textContent ?? "";
    expect(text.indexOf("Review the parser")).toBeLessThan(
      text.indexOf("Skill · Code review"),
    );
  });

  it("keeps references when editing so they are not resent as text", () => {
    render(
      <UserMessageBlock
        messageId="user1"
        content="Review the parser"
        references={references}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(screen.getByRole("textbox")).toHaveValue("Review the parser");
    expect(
      screen.getByRole("list", { name: "References for this message" }),
    ).toBeInTheDocument();
  });

  it("renders no tags for messages without references", () => {
    render(<UserMessageBlock content="Plain message" />);
    expect(
      screen.queryByRole("list", { name: "References for this message" }),
    ).toBeNull();
  });
});
