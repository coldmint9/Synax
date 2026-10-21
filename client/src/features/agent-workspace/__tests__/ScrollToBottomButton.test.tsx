import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScrollToBottomButton, isAwayFromBottom } from "../ScrollToBottomButton";

afterEach(() => vi.unstubAllGlobals());

/** A scrollport whose metrics are driven by the test, like a real transcript. */
function makeScrollport(scrollHeight: number, clientHeight: number) {
  const element = document.createElement("div");
  element.appendChild(document.createElement("div"));
  let height = scrollHeight;
  const viewport = clientHeight;
  let top = height - viewport;
  Object.defineProperties(element, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => viewport },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - viewport));
      },
    },
  });
  return {
    element,
    scrollTo: (nextTop: number) => {
      element.scrollTop = nextTop;
      element.dispatchEvent(new Event("scroll"));
    },
    grow: (nextHeight: number) => {
      height = nextHeight;
    },
  };
}

function button() {
  const element = document.querySelector<HTMLButtonElement>(
    ".session-scroll-to-bottom",
  );
  if (!element) throw new Error("jump-to-latest button is not mounted");
  return element;
}

it("treats the bottom tenth of the scroll range as the live edge", () => {
  // 5000px of scroll range: the last 500px still counts as "at the bottom".
  expect(isAwayFromBottom(4500, 500, 5500)).toBe(false);
  expect(isAwayFromBottom(4400, 500, 5500)).toBe(true);
  // A range that cannot scroll has no bottom to leave behind.
  expect(isAwayFromBottom(0, 500, 500)).toBe(false);
  // A couple of pixels of slack in a nearly empty transcript is not history reading.
  expect(isAwayFromBottom(0, 500, 520)).toBe(false);
});

it("appears past the bottom tenth and hides again at the live edge", () => {
  const port = makeScrollport(5000, 500);
  render(
    <ScrollToBottomButton
      scrollRef={{ current: port.element }}
      onScrollToBottom={vi.fn()}
    />,
  );
  // Hidden controls stay out of both the pointer and the tab order.
  expect(button()).toHaveAttribute("data-visible", "false");
  expect(button()).toHaveAttribute("aria-hidden", "true");
  expect(button()).toHaveAttribute("tabindex", "-1");

  act(() => port.scrollTo(4000));
  expect(button()).toHaveAttribute("data-visible", "true");
  expect(button()).not.toHaveAttribute("aria-hidden");
  expect(button()).toHaveAttribute("tabindex", "0");

  act(() => port.scrollTo(4500));
  expect(button()).toHaveAttribute("data-visible", "false");
});

it("re-reads the verdict after layout settles, without a scroll event", () => {
  let onResize!: ResizeObserverCallback;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        onResize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const port = makeScrollport(5000, 500);
  render(
    <ScrollToBottomButton
      scrollRef={{ current: port.element }}
      onScrollToBottom={vi.fn()}
    />,
  );
  expect(button()).toHaveAttribute("data-visible", "false");
  // Streamed turns grow the transcript; the reader never scrolled, yet the
  // bottom tenth moved away from them.
  act(() => {
    port.grow(9000);
    onResize([], {} as ResizeObserver);
  });
  expect(button()).toHaveAttribute("data-visible", "true");
});

it("scrolls back to the live edge when pressed", () => {
  const onScrollToBottom = vi.fn();
  const port = makeScrollport(5000, 500);
  render(
    <ScrollToBottomButton
      scrollRef={{ current: port.element }}
      onScrollToBottom={onScrollToBottom}
    />,
  );
  act(() => port.scrollTo(1200));
  act(() => button().click());
  expect(onScrollToBottom).toHaveBeenCalledTimes(1);
});

it("labels the control in the reader's language", () => {
  const port = makeScrollport(5000, 500);
  render(
    <ScrollToBottomButton
      scrollRef={{ current: port.element }}
      onScrollToBottom={vi.fn()}
    />,
  );
  expect(button().getAttribute("aria-label")).toMatch(
    /滚动到底部|Scroll to bottom/,
  );
});
