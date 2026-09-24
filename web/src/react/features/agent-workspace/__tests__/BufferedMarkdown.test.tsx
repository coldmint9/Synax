import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferedMarkdown } from "../BufferedMarkdown";

afterEach(() => vi.useRealTimers());

describe("BufferedMarkdown", () => {
  it("reveals complete lines through a short buffer", () => {
    vi.useFakeTimers();
    const { container } = render(
      <BufferedMarkdown content={"# Answer\nSecond line"} isStreaming />,
    );

    expect(container.querySelector("h1")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector("h1")).toHaveTextContent("Answer");
    expect(container).not.toHaveTextContent("Second line");
    act(() => vi.advanceTimersByTime(160));
    expect(container).toHaveTextContent("Second line");
  });

  it("waits for the work-log collapse before showing the final answer", () => {
    vi.useFakeTimers();
    const { container } = render(
      <BufferedMarkdown
        content="Final answer"
        isStreaming={false}
        startDelayMs={420}
      />,
    );
    expect(container).not.toHaveTextContent("Final answer");
    act(() => vi.advanceTimersByTime(419));
    expect(container).not.toHaveTextContent("Final answer");
    act(() => vi.advanceTimersByTime(1));
    expect(container).toHaveTextContent("Final answer");
  });

  it("keeps an unfinished code fence plain until the closing fence arrives", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <BufferedMarkdown content={"Before\n```ts\nconst x = 1"} isStreaming />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(
      container.querySelector(".markdown-stream-pending"),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".wiki-shiki-block"),
    ).not.toBeInTheDocument();

    rerender(
      <BufferedMarkdown
        content={"Before\n```ts\nconst x = 1\n```"}
        isStreaming
      />,
    );
    act(() => vi.advanceTimersByTime(200));
    vi.useRealTimers();
    await waitFor(
      () =>
        expect(
          container.querySelector(".wiki-shiki-block"),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });
});
