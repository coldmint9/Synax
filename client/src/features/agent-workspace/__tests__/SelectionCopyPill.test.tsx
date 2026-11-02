import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../../../adapters/electron/clipboard";
import { SelectionCopyPill } from "../SelectionCopyPill";

vi.mock("../../../adapters/electron/clipboard", () => ({
  copyTextToClipboard: vi.fn(),
}));
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));

const copyMock = vi.mocked(copyTextToClipboard);

const HOST_RECT = {
  top: 0,
  bottom: 300,
  left: 0,
  right: 400,
  width: 400,
  height: 300,
  x: 0,
  y: 0,
} as DOMRect;

const LINE_RECT = {
  top: 100,
  bottom: 118,
  left: 50,
  right: 170,
  width: 120,
  height: 18,
  x: 50,
  y: 100,
} as DOMRect;

function rectAt(top: number): DOMRect {
  return { ...LINE_RECT, top, bottom: top + LINE_RECT.height, y: top } as DOMRect;
}

/** The transcript viewport, its scrolling body and the message scope. */
function Harness() {
  const hostRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const element of [hostRef.current, scrollRef.current]) {
      if (element) element.getBoundingClientRect = () => HOST_RECT;
    }
  }, []);
  return (
    <div ref={hostRef} className="transcript-viewport">
      <div ref={scrollRef} className="transcript-scroll">
        <div ref={scopeRef} className="transcript-scope" data-testid="scope">
          <p>我会先查看工作区结构</p>
        </div>
      </div>
      <SelectionCopyPill
        hostRef={hostRef}
        scopeRef={scopeRef}
        scrollRef={scrollRef}
      />
    </div>
  );
}

const restores: Array<() => void> = [];

function stubSelection(node: Node, text: string, range?: Range) {
  const browserRange = range ?? document.createRange();
  if (!range) browserRange.selectNodeContents(node);
  const selection = {
    anchorNode: node,
    focusNode: node,
    rangeCount: 1,
    getRangeAt: () => browserRange,
    toString: () => text,
  } as unknown as Selection;
  const saved = Object.getOwnPropertyDescriptor(window, "getSelection");
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    writable: true,
    value: () => selection,
  });
  restores.push(() => {
    if (saved) Object.defineProperty(window, "getSelection", saved);
    else delete (window as unknown as Record<string, unknown>).getSelection;
  });
}

function stubRangeGeometry(rect: DOMRect) {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  for (const [name, value] of [
    ["getClientRects", () => [rect]],
    ["getBoundingClientRect", () => rect],
  ] as const) {
    const saved = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      value,
    });
    restores.push(() => {
      if (saved) Object.defineProperty(proto, name, saved);
      else delete proto[name];
    });
  }
}

function renderHarness() {
  const view = render(<Harness />);
  const scope = screen.getByTestId("scope");
  const message = scope.querySelector("p")!;
  return { ...view, scope, message };
}

/** Let the copy promise settle inside React's act scope. */
async function finishCopy() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  while (restores.length) restores.pop()?.();
});

describe("SelectionCopyPill", () => {
  it("copies the finished selection and parks the pill under its last line", async () => {
    stubRangeGeometry(LINE_RECT);
    const { scope, message } = renderHarness();
    stubSelection(message.firstChild!, "我会先查看工作区结构");

    fireEvent.mouseUp(scope);
    await finishCopy();

    expect(copyMock).toHaveBeenCalledWith("我会先查看工作区结构");
    const pill = screen.getByRole("status");
    expect(pill).toHaveTextContent("已复制到剪贴板");
    expect(pill).toHaveAttribute("data-visible", "true");
    expect(pill).toHaveAttribute("data-placement", "below");
    expect(pill.style.top).toBe("126px");
    expect(pill.style.getPropertyValue("--selection-copy-x")).toBe("110px");
  });

  it("fades the pill out two seconds later instead of stacking confirmations", async () => {
    stubRangeGeometry(LINE_RECT);
    const { scope, message } = renderHarness();
    stubSelection(message.firstChild!, "我会先查看工作区结构");

    fireEvent.mouseUp(scope);
    await finishCopy();
    expect(screen.getByRole("status")).toHaveAttribute("data-visible", "true");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status")).toHaveAttribute("data-visible", "false");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays silent for selections that are too short or outside the transcript", async () => {
    stubRangeGeometry(LINE_RECT);
    const { scope, message } = renderHarness();

    stubSelection(message.firstChild!, "我");
    fireEvent.mouseUp(scope);
    await finishCopy();
    expect(copyMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();

    const outside = document.createElement("p");
    document.body.appendChild(outside);
    stubSelection(outside, "侧栏里的内容");
    fireEvent.mouseUp(scope);
    await finishCopy();
    expect(copyMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    outside.remove();
  });

  it("shows nothing when the clipboard write fails", async () => {
    copyMock.mockResolvedValue(false);
    stubRangeGeometry(LINE_RECT);
    const { scope, message } = renderHarness();
    stubSelection(message.firstChild!, "我会先查看工作区结构");

    fireEvent.mouseUp(scope);
    await finishCopy();

    expect(copyMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("flips above the selection when the last line sits at the viewport edge", async () => {
    stubRangeGeometry(rectAt(272));
    const { scope, message } = renderHarness();
    stubSelection(message.firstChild!, "我会先查看工作区结构");

    fireEvent.mouseUp(scope);
    await finishCopy();

    const pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("data-placement", "above");
    expect(pill.style.top).toBe("236px");
  });
});
