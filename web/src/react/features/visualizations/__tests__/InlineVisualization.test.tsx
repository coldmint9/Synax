import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineVisualization } from "../InlineVisualization";
import { visualizationDocument, VISUALIZATION_CSP } from "../document";

const visualization = {
  id: "message:demo",
  html: '<div id="demo"><button class="btn">Hello</button></div>',
};
function config(frame: HTMLIFrameElement) {
  return JSON.parse(
    frame.srcdoc.match(
      /id="synax-visualization-config" type="application\/json">([^<]+)</,
    )![1],
  );
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
    expect(frame).toHaveAttribute("csp", VISUALIZATION_CSP);
    expect(frame.srcdoc).toContain(visualization.html);
    expect(frame.srcdoc).toContain(".btn-primary");
    expect(config(frame).icons.sparkles).toContain("<svg");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
  it("only accepts authenticated numeric resize from its own frame", async () => {
    render(<InlineVisualization visualization={visualization} />);
    const frame = screen.getByTitle("交互预览") as HTMLIFrameElement;
    const c = config(frame);
    const data = {
      channel: "synax-visualization",
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
      channel: "synax-visualization",
      ...config(second),
      type: "error",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("预览未能运行");
    expect(view.container.querySelector("iframe")).toBeNull();
    view.unmount();
    expect(first.isConnected).toBe(false);
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
    const html = visualizationDocument("<p>Demo</p>", {
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
