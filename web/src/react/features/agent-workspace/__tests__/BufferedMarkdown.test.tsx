import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferedMarkdown } from "../BufferedMarkdown";

afterEach(() => vi.useRealTimers());

describe("BufferedMarkdown", () => {
  it("reveals complete lines as Markdown and the partial line as plain text", () => {
    vi.useFakeTimers();
    const { container } = render(
      <BufferedMarkdown content={"# Answer\nSecond line"} isStreaming />,
    );

    expect(container.querySelector("h1")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector("h1")).toHaveTextContent("Answer");
    // The line without its newline yet stays visible as a plain-text tail.
    expect(container.querySelector(".markdown-stream-tail")).toHaveTextContent(
      "Second line",
    );
  });

  it("streams a long single paragraph instead of freezing until its newline", () => {
    vi.useFakeTimers();
    const paragraph =
      "这是一个很长的段落，模拟模型连续输出且长时间不换行的场景，旧实现会一直不渲染直到段落结束。";
    const { container, rerender } = render(
      <BufferedMarkdown content={paragraph.slice(0, 12)} isStreaming />,
    );
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector(".markdown-stream-tail")).toHaveTextContent(
      paragraph.slice(0, 12),
    );

    // Tokens keep arriving well within the old idle window: each burst must
    // become visible, not wait for the paragraph's closing newline.
    rerender(<BufferedMarkdown content={paragraph.slice(0, 60)} isStreaming />);
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector(".markdown-stream-tail")).toHaveTextContent(
      paragraph.slice(0, 60),
    );

    rerender(<BufferedMarkdown content={paragraph} isStreaming />);
    act(() => vi.advanceTimersByTime(40));
    expect(container).toHaveTextContent(paragraph);

    // Once the stream ends the tail is promoted into parsed Markdown.
    rerender(<BufferedMarkdown content={paragraph} isStreaming={false} />);
    expect(
      container.querySelector(".markdown-stream-tail"),
    ).not.toBeInTheDocument();
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
