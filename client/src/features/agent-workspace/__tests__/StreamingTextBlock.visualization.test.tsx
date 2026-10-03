import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StreamingTextBlock } from "../StreamingTextBlock";

describe("StreamingTextBlock visualization loading", () => {
  it("hides streaming visualization source and shows the ASCII placeholder", () => {
    const source = "说明文字\n\n```synax-visualize\n<div>secret source</div>";
    const { container } = render(
      <StreamingTextBlock text={source} isStreaming markdown />,
    );

    expect(container).not.toHaveTextContent("secret source");
    expect(container.querySelector('[role="status"][aria-label="正在生成交互预览"]')).toBeInTheDocument();
    expect(container.querySelector(".visualization-loading")).toBeInTheDocument();
  });
});
