import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { VirtualActivityWindow } from "../VirtualActivityWindow";
import {
  useActivityRowActive,
  useActivityRowExpansion,
  useCompactActivityRow,
} from "../ActivityRowScope";

const rows = Array.from({ length: 20 }, (_, index) => ({
  key: `row-${index}`,
  node: <div>row {index}</div>,
}));

function CompactProbe() {
  return <span data-compact={String(useCompactActivityRow())} />;
}

/** A record row that opens itself the way a tool call or thought does. */
function ExpandProbe() {
  const expand = useActivityRowExpansion();
  const compact = useCompactActivityRow();
  const active = useActivityRowActive();
  const [open, setOpen] = useState(false);
  const expanded = open && (!compact || active);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => {
        if (compact && !active) {
          expand?.();
          if (!open) setOpen(true);
          return;
        }
        setOpen(!expanded);
      }}
    >
      record
    </button>
  );
}

describe("VirtualActivityWindow", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 210,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 600,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  });

  it("keeps a fixed height budget and follows the newest rows", () => {
    const { container } = render(<VirtualActivityWindow rows={rows} windowed />);
    const viewport = container.querySelector(".session-process-window-viewport")!;
    const frame = container.querySelector(".session-process-window-frame")!;
    expect(viewport).toHaveAttribute("data-windowed", "true");
    expect(viewport).toHaveStyle({ maxHeight: "210px", "--process-row-h": "30px" });
    const mounted = [...container.querySelectorAll("[data-row-key]")];
    expect(mounted.length).toBeLessThan(rows.length);
    // Newest at the bottom: the window shows the tail of the transcript.
    expect(mounted[mounted.length - 1]).toHaveAttribute("data-row-key", "row-19");
    // Rows above the window are reported by a top fade, not a bottom one.
    expect(frame).toHaveAttribute("data-fade-top", "true");
    expect(frame).not.toHaveAttribute("data-fade-bottom");
    // The head spacer keeps the scroll range of the rows that are not mounted.
    const spacer = container.querySelector(".session-process-window-spacer");
    expect(
      Number.parseInt(spacer?.getAttribute("style")?.match(/height: (\d+)px/)?.[1] ?? "0", 10),
    ).toBeGreaterThan(0);
  });

  it("marks its rows as one-line records", () => {
    const probe = [{ key: "probe", node: <CompactProbe /> }];
    const { container } = render(<VirtualActivityWindow rows={probe} windowed />);
    expect(container.querySelector("[data-compact]")).toHaveAttribute("data-compact", "true");
  });

  it("expands only the record the reader opens and keeps the window virtualized", () => {
    const probeRows = rows.map((row, index) => ({
      ...row,
      node: index === 18 ? <ExpandProbe /> : row.node,
    }));
    const { container } = render(<VirtualActivityWindow rows={probeRows} windowed />);
    const viewport = container.querySelector(".session-process-window-viewport")!;
    const mounted = container.querySelectorAll("[data-row-key]").length;
    expect(mounted).toBeLessThan(probeRows.length);

    fireEvent.click(container.querySelector('[data-row-key="row-18"] button')!);

    // The opened record grows; the rest of the window stays a fixed row budget
    // instead of unfolding every record in the transcript.
    expect(viewport).toHaveAttribute("data-windowed", "true");
    expect(container.querySelectorAll("[data-row-expanded]")).toHaveLength(1);
    expect(container.querySelector('[data-row-key="row-18"]')).toHaveAttribute(
      "data-row-expanded",
      "true",
    );
    expect(container.querySelector('[data-row-key="row-19"]')).not.toHaveAttribute(
      "data-row-expanded",
    );
    expect(container.querySelectorAll("[data-row-key]").length).toBe(mounted);
  });

  it("keeps one open record at a time when the reader switches rows", () => {
    const probeRows = rows.map((row, index) => ({
      ...row,
      node: index >= 18 ? <ExpandProbe /> : row.node,
    }));
    const { container } = render(<VirtualActivityWindow rows={probeRows} windowed />);
    const row = (key: string) => container.querySelector(`[data-row-key="${key}"]`)!;
    const button = (key: string) => row(key).querySelector("button")!;

    fireEvent.click(button("row-18"));
    expect(button("row-18")).toHaveAttribute("aria-expanded", "true");
    expect(button("row-19")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button("row-19"));
    expect(button("row-19")).toHaveAttribute("aria-expanded", "true");
    expect(button("row-18")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-row-expanded]")).toHaveLength(1);

    // Returning to the record opened earlier opens it again instead of
    // toggling a body that is already remembered as open.
    fireEvent.click(button("row-18"));
    expect(button("row-18")).toHaveAttribute("aria-expanded", "true");
    expect(button("row-19")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('[data-row-key="row-18"]')).toHaveAttribute(
      "data-row-expanded",
      "true",
    );
  });

  it("counts the opened row's natural height without laying out the list", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const height = this.hasAttribute("data-row-expanded") ? 120 : 0;
        return {
          height,
          width: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    const probeRows = rows.map((row, index) => ({
      ...row,
      node: index === 2 ? <ExpandProbe /> : row.node,
    }));
    const { container } = render(<VirtualActivityWindow rows={probeRows} windowed />);
    const viewport = container.querySelector(".session-process-window-viewport")!;
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);

    fireEvent.click(container.querySelector('[data-row-key="row-2"] button')!);

    // 20 rows at 30px, one opened at 120px: total 690px, and the window keeps
    // its 210px budget while the opened row's extra 90px stays scrollable.
    const bottomSpacer = [...container.querySelectorAll(".session-process-window-spacer")].pop()!;
    expect(Number.parseFloat((bottomSpacer as HTMLElement).style.height)).toBe(390);
    expect(viewport).toHaveStyle({ height: "210px" });
    expect(container.querySelectorAll("[data-row-key]").length).toBeLessThan(probeRows.length);
  });

  it("reports records below once the reader leaves the newest one", () => {
    const { container } = render(<VirtualActivityWindow rows={rows} windowed />);
    const viewport = container.querySelector(".session-process-window-viewport")!;
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    const frame = container.querySelector(".session-process-window-frame")!;
    expect(frame).not.toHaveAttribute("data-fade-top");
    expect(frame).toHaveAttribute("data-fade-bottom", "true");
    expect(
      container.querySelector("[data-row-key]"),
    ).toHaveAttribute("data-row-key", "row-0");
  });

  it("renders finished turns in place, without a window", () => {
    const { container } = render(<VirtualActivityWindow rows={rows} />);
    expect(container.querySelectorAll("[data-row-key]")).toHaveLength(rows.length);
    expect(container.querySelector(".session-process-window-viewport"))
      .not.toHaveAttribute("data-windowed");
    expect(container.querySelector("[data-compact]")).toBeNull();
  });
  it("keeps removed rows inert for their exit, then releases them", () => {
    vi.useFakeTimers();
    const initial = rows.slice(0, 3);
    const { container, rerender } = render(<VirtualActivityWindow rows={initial} windowed animate />);
    const first = container.querySelector('[data-row-key="row-0"]');
    rerender(<VirtualActivityWindow rows={initial.slice(0, 2)} windowed animate />);
    expect(container.querySelector('[data-row-key="row-2"]')).toHaveAttribute("inert");
    expect(container.querySelector('[data-row-key="row-2"]')).toHaveAttribute("aria-hidden", "true");
    act(() => vi.advanceTimersByTime(160));
    expect(container.querySelector('[data-row-key="row-2"]')).toBeNull();
    expect(container.querySelector('[data-row-key="row-0"]')).toBe(first);
    expect(container.querySelector(".session-process-window-viewport")).toHaveStyle({ height: "60px" });
  });

  it("does not duplicate or remove a record re-added during its exit", () => {
    vi.useFakeTimers();
    const initial = rows.slice(0, 3);
    const { container, rerender } = render(<VirtualActivityWindow rows={initial} windowed animate />);
    const last = container.querySelector('[data-row-key="row-2"]');
    rerender(<VirtualActivityWindow rows={initial.slice(0, 2)} windowed animate />);
    rerender(<VirtualActivityWindow rows={initial} windowed animate />);
    act(() => vi.advanceTimersByTime(160));
    expect(container.querySelectorAll('[data-row-key="row-2"]')).toHaveLength(1);
    expect(container.querySelector('[data-row-key="row-2"]')).toBe(last);
    expect(last).not.toHaveAttribute("inert");
  });

});
