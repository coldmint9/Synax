import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useShellStore } from "../../../state/shellStore";
import { ThinkingIndicator } from "../ThinkingIndicator";

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
});

describe("ThinkingIndicator", () => {
  it("shows a slow 3×3 pixel grid and visible Chinese thinking label", () => {
    const { container } = render(<ThinkingIndicator />);
    const status = screen.getByRole("status");
    const cells = Array.from(status.querySelectorAll(".loading-state-cell"));

    expect(status).toHaveTextContent("正在思考");
    expect(cells).toHaveLength(9);
    expect(status.querySelector('[aria-hidden="true"]')).toContainElement(cells[0] as HTMLElement);
    expect(cells.every((cell) => (cell as HTMLElement).style.animation.includes("2400ms"))).toBe(true);
    expect(container.querySelector("[data-thinking-dot]")).toBeNull();
  });

  it("shows the English label in English locale", () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
    render(<ThinkingIndicator />);

    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });
});
