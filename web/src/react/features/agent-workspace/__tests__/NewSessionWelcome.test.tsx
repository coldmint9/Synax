import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewSessionWelcome } from "../NewSessionWelcome";
import { SynaxWordmark } from "../SynaxWordmark";
import { SessionTimeGroups } from "../SessionTimeGroups";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh", t: (key: string) => key }),
}));

describe("new session identity", () => {
  it("gives the ASCII wordmark one accessible name without reading its punctuation", () => {
    render(<NewSessionWelcome />);
    const mark = screen.getByRole("img", { name: "Synax" });
    expect(mark.querySelector("pre")).toHaveAttribute("aria-hidden", "true");
    expect(mark.textContent).toMatch(/^[\x20-\x7e\n]+$/);
    expect(mark.textContent?.split("\n")).toHaveLength(5);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "sessionDraftTitle",
    );
    expect(screen.queryByText("sessionDraftHint")).not.toBeInTheDocument();
  });

  it("supports the compact sidebar mark", () => {
    render(<SynaxWordmark compact />);
    expect(screen.getByRole("img", { name: "Synax" })).toHaveClass(
      "synax-wordmark--compact",
    );
  });

  it("replaces the coffee emoji without losing custom empty and search labels", () => {
    const { container } = render(
      <SessionTimeGroups
        groups={[]}
        selectedId={null}
        isLoadingMore={false}
        hasMore={false}
        emptyLabel="还没有会话，从一个念头开始"
        onSelect={vi.fn()}
        onToggleGroup={vi.fn()}
        onToggleExpand={vi.fn()}
        onLoadMore={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain("☕");
    expect(screen.getByRole("img", { name: "Synax" })).toBeInTheDocument();
    expect(screen.getByText("还没有会话，从一个念头开始")).toBeInTheDocument();
  });
});
