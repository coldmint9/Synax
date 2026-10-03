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

  it("renders Markdown images responsively and opens a zoom preview", () => {
    render(
      <MarkdownRenderer
        content={"![Screenshot](https://example.com/screenshot.png)"}
      />,
    );
    const image = screen.getByRole("img", { name: "Screenshot" });
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveClass("markdown-image");

    fireEvent.click(
      screen.getByRole("button", { name: "放大图片：Screenshot" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Screenshot" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Screenshot" }),
    ).not.toBeInTheDocument();
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
