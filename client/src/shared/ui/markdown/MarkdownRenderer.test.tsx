import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("renders inline and block formulas with KaTeX", () => {
    const { container } = render(
      <MarkdownRenderer
        content={"Inline $E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$"}
      />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });

  it("renders Markdown images responsively and opens a zoom preview", async () => {
    render(
      <MarkdownRenderer
        content={"![Screenshot](https://example.com/screenshot.png)"}
      />,
    );
    const image = screen.getByRole("img", { name: "Screenshot" });
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveClass("markdown-image");

    const trigger = screen.getByRole("button", { name: "放大图片：Screenshot" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Screenshot" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "关闭图片预览" }), { key: "Escape" });
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Screenshot" }),
    ).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps multiple thumbnails inside the text flow and previews the selected image", async () => {
    const { container } = render(<MarkdownRenderer content={"正文 ![第一张](https://example.com/one.png) ![第二张](https://example.com/two.png) 后文"} />);
    expect(container.querySelectorAll("p .markdown-image-trigger")).toHaveLength(2);
    const trigger = screen.getByRole("button", { name: "放大图片：第二张" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "第二张" }).querySelector("img")).toHaveAttribute("src", "https://example.com/two.png");
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows a failed thumbnail without opening a broken preview and recovers for a new source", () => {
    const { rerender } = render(<MarkdownRenderer content={"![截图](https://example.com/missing.png)"} />);
    fireEvent.error(screen.getByRole("img", { name: "截图" }));
    expect(screen.getByRole("status")).toHaveTextContent("图片加载失败：截图");
    expect(screen.getByRole("button", { name: "图片加载失败：截图" })).toBeDisabled();
    rerender(<MarkdownRenderer content={"![截图](https://example.com/available.png)"} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放大图片：截图" })).toBeEnabled();
  });

  it("highlights fenced source code through the shared Shiki component", async () => {
    const { container } = render(
      <MarkdownRenderer content={"```ts\nconst answer: number = 42\n```"} />,
    );
    expect(container.querySelector(".markdown-code-block__header")).toHaveTextContent("ts");
    await waitFor(
      () =>
        expect(
          container.querySelector(".md-shiki-block .shiki"),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it.each([
    ["```\nhello\n```", "纯文本"],
    ["```text\nhello\n```", "纯文本"],
    ["```unknown-format\nhello\n```", "unknown-format"],
  ])("labels code fences including single-line plain text: %s", (content, label) => {
    const { container } = render(<MarkdownRenderer content={content} />);
    expect(container.querySelector(".markdown-code-block__header")).toHaveTextContent(label);
    expect(container.querySelector(".markdown-code-block pre code")).toHaveTextContent("hello");
  });

  it("keeps inline code inline without a format header", () => {
    const { container } = render(<MarkdownRenderer content={"Use `hello` here."} />);
    expect(container.querySelector("p code")).toHaveTextContent("hello");
    expect(container.querySelector(".markdown-code-block")).not.toBeInTheDocument();
  });
});
