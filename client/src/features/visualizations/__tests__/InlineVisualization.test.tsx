import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineVisualization } from "../InlineVisualization";
import {
  interactiveDocument,
  readInteractiveDocumentConfig,
  INTERACTIVE_CSP,
  type InteractiveDocumentConfig,
} from "../../../shared/interactive/document";

const visualization = {
  id: "message:demo",
  html: '<div id="demo"><button class="btn">Hello</button></div>',
};
function config(frame: HTMLIFrameElement) {
  const parsed = readInteractiveDocumentConfig(frame.srcdoc);
  if (!parsed) throw new Error("missing frame config");
  return parsed as InteractiveDocumentConfig & {
    icons: Record<string, string>;
  };
}
function receive(
  frame: HTMLIFrameElement,
  data: object,
  source: Window | null = frame.contentWindow,
) {
  act(() =>
    window.dispatchEvent(new MessageEvent("message", { data, source })),
  );
}

describe("InlineVisualization", () => {
  it("mounts one opaque iframe, host styles and real icons, without product management chrome", () => {
    render(<InlineVisualization visualization={visualization} />);
    const frame = screen.getByTitle("交互预览") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).not.toHaveAttribute("allow");
    expect(frame.loading).toBe("eager");
    expect(frame).toHaveAttribute("csp", INTERACTIVE_CSP);
    expect(frame.srcdoc).toContain(visualization.html);
    expect(frame.srcdoc).toContain(".btn-primary");
    expect(config(frame).icons.sparkles).toContain("<svg");
    // The host adds exactly the two hover controls; everything else in the card
    // stays product chrome owned by the generated fragment.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
  it("collapses to a small blurred placeholder card and restores the frame", () => {
    render(
      <InlineVisualization
        visualization={{ ...visualization, title: "智能客服全景" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "折叠预览" }));
    expect(screen.queryByTitle("智能客服全景")).toBeNull();
    const placeholder = screen.getByRole("button", {
      name: "展开预览：智能客服全景",
    });
    expect(placeholder).toHaveTextContent("智能客服全景");
    expect(placeholder).toHaveTextContent("已折叠");
    expect(
      placeholder.querySelector(".inline-visualization__collapsed-art"),
    ).not.toBeNull();
    fireEvent.click(placeholder);
    expect(screen.getByTitle("智能客服全景")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "展开预览：智能客服全景" }),
    ).toBeNull();
  });
  it("opens the full-screen viewer beside the preview and closes with Escape", async () => {
    render(<InlineVisualization visualization={visualization} />);
    fireEvent.click(screen.getByRole("button", { name: "在查看器中打开预览" }));
    const viewer = await screen.findByRole("dialog");
    expect(viewer).toHaveTextContent("交互预览");
    expect(screen.getAllByTitle("交互预览")).toHaveLength(2);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByTitle("交互预览")).toHaveLength(1);
  });
  it("only accepts authenticated numeric resize from its own frame", async () => {
    render(<InlineVisualization visualization={visualization} />);
    const frame = screen.getByTitle("交互预览") as HTMLIFrameElement;
    const c = config(frame);
    const data = {
      channel: "synax-interactive",
      id: c.id,
      token: c.token,
      type: "resize",
      height: 384,
    };
    receive(frame, data, window);
    receive(frame, { ...data, token: "forged" });
    receive(frame, { ...data, height: "384" });
    expect(frame.style.height).toBe("240px");
    receive(frame, data);
    await waitFor(() => expect(frame.style.height).toBe("384px"));
    receive(frame, { ...data, height: 99999 });
    expect(frame.style.height).toBe("8192px");
  });
  it("resets identity on replacement and removes frames for errors / unmount", async () => {
    const view = render(<InlineVisualization visualization={visualization} />);
    const first = screen.getByTitle("交互预览") as HTMLIFrameElement;
    const oldConfig = config(first);
    view.rerender(
      <InlineVisualization visualization={{ ...visualization, id: "next" }} />,
    );
    const second = screen.getByTitle("交互预览") as HTMLIFrameElement;
    expect(config(second).token).not.toBe(oldConfig.token);
    receive(second, {
      channel: "synax-interactive",
      ...config(second),
      type: "error",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("预览未能运行");
    expect(view.container.querySelector("iframe")).toBeNull();
    view.unmount();
    expect(first.isConnected).toBe(false);
  });
  it("explains a missing snapshot instead of spinning forever", () => {
    render(<InlineVisualization visualization={{ id: "empty" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("预览内容缺失");
    expect(screen.queryByTitle("交互预览")).toBeNull();
  });
  it("shows stored validation errors without mounting an executable frame", () => {
    render(
      <InlineVisualization
        visualization={{ id: "error", error: "请简化预览" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("请简化预览");
    expect(screen.queryByTitle("交互预览")).toBeNull();
  });
  it("escapes config strings and does not enable eval/network or same-origin access", () => {
    const html = interactiveDocument("<p>Demo</p>", {
      id: "</script><img>",
      token: "</script>",
      theme: "dark",
    });
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("unsafe-eval");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("https://");
  });
});
