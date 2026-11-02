import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerOverlayInset } from "../useComposerOverlayInset";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function SideChatHarness() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useComposerOverlayInset(bodyRef, composerRef);
  return (
    <>
      <div ref={bodyRef} className="side-chat-body">
        <div className="session-workspace-scroll" />
      </div>
      <div ref={composerRef} className="side-chat-composer">
        <div className="agent-session-composer--footer" />
      </div>
    </>
  );
}

/** The panel keeps its edge; only the composer's top moves. */
const HOST_BOTTOM = 520;

function stubGeometry(composerTop: () => number) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.classList.contains("side-chat-body") ? 0 : composerTop(),
        bottom: HOST_BOTTOM,
      } as DOMRect;
    },
  );
}

function insetOf(container: HTMLElement) {
  return container
    .querySelector<HTMLElement>(".side-chat-body")!
    .style.getPropertyValue("--side-chat-composer-inset");
}

it("reserves the height the floating composer covers", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  stubGeometry(() => 384);
  const view = render(<SideChatHarness />);
  expect(insetOf(view.container)).toBe("136px");
});

it("follows a composer that grows and drops the inset on unmount", () => {
  let notify: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const composerTop = { current: 460 };
  stubGeometry(() => composerTop.current);
  const view = render(<SideChatHarness />);
  expect(insetOf(view.container)).toBe("60px");

  // A queue strip or a wrapping suggestion makes the composer taller.
  composerTop.current = 400;
  act(() => notify?.());
  expect(insetOf(view.container)).toBe("120px");

  const host = view.container.querySelector<HTMLElement>(".side-chat-body")!;
  view.unmount();
  expect(host.style.getPropertyValue("--side-chat-composer-inset")).toBe("");
});
