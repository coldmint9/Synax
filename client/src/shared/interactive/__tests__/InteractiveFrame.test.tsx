import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_CHANNEL, InteractiveFrame } from "../InteractiveFrame";
import { readInteractiveDocumentConfig } from "../document";
import { clearInteractiveState, readInteractiveState } from "../state-store";

const html = '<p>Demo</p>';

function frame(): HTMLIFrameElement {
  return screen.getByTitle("应用预览") as HTMLIFrameElement;
}
function config() {
  const parsed = readInteractiveDocumentConfig(frame().srcdoc);
  if (!parsed) throw new Error("missing frame config");
  return parsed as { id: string; token: string; state?: unknown };
}
function receive(data: object, source: Window | null = frame().contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, source })));
}
function send(type: string, extra: object = {}) {
  const c = config();
  receive({ channel: INTERACTIVE_CHANNEL, id: c.id, token: c.token, type, ...extra });
}

afterEach(() => {
  clearInteractiveState("probe");
  vi.useRealTimers();
});

describe("InteractiveFrame", () => {
  it("reports ready only after one authenticated handshake from its own frame", () => {
    const onReady = vi.fn();
    render(<InteractiveFrame id="app" html={html} title="应用预览" onReady={onReady} />);
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame().style.height).toBe("240px");
    receive({ channel: INTERACTIVE_CHANNEL, id: "other", token: "x", type: "ready" });
    expect(onReady).not.toHaveBeenCalled();
    send("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-interactive-phase="ready"]'),
    ).not.toBeNull();
  });

  it("clamps tall content to maxHeight and flags the internal scroll area", () => {
    render(<InteractiveFrame id="app" html={html} title="应用预览" />);
    send("resize", { height: 99999 });
    expect(frame().style.height).toBe("8192px");
    expect(
      document.querySelector('[data-interactive-overflow="true"]'),
    ).not.toBeNull();
    send("resize", { height: 420 });
    expect(frame().style.height).toBe("420px");
    expect(
      document.querySelector('[data-interactive-overflow="true"]'),
    ).toBeNull();
  });

  it("survives resize bursts that animation-heavy apps produce", () => {
    const onError = vi.fn();
    render(
      <InteractiveFrame id="app" html={html} title="应用预览" onError={onError} />,
    );
    const c = config();
    act(() => {
      for (let index = 1; index <= 300; index++)
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              channel: INTERACTIVE_CHANNEL,
              id: c.id,
              token: c.token,
              type: "resize",
              height: 300 + index,
            },
            source: frame().contentWindow,
          }),
        );
    });
    expect(onError).not.toHaveBeenCalled();
    // Messages beyond the per-window budget are dropped, not fatal: the frame
    // keeps the last accepted size (240 accepted resizes of 300..539).
    expect(frame().style.height).toBe("540px");
  });

  it("restores the host-kept interaction state on remount", () => {
    const view = render(
      <InteractiveFrame id="app" html={html} title="应用预览" stateKey="probe" />,
    );
    const state = { modelContent: { tab: "b" }, privateContent: null };
    send("state", { state });
    expect(readInteractiveState("probe")).toEqual(state);
    view.unmount();
    render(<InteractiveFrame id="app" html={html} title="应用预览" stateKey="probe" />);
    expect(config().state).toEqual(state);
  });

  it("reports a configurable handshake timeout instead of spinning forever", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    render(
      <InteractiveFrame
        id="app"
        html={html}
        title="应用预览"
        timeoutMs={5_000}
        onError={onError}
      />,
    );
    act(() => vi.advanceTimersByTime(5_001));
    expect(onError).toHaveBeenCalledWith(
      "预览加载超时，请让助手简化内容后重新生成。",
    );
  });
});
