import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VirtualActivityWindow } from "../VirtualActivityWindow";

const rows = Array.from({ length: 20 }, (_, index) => ({
  key: `row-${index}`,
  node: <div>row {index}</div>,
}));

describe("VirtualActivityWindow", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 30,
      width: 320,
      top: 0,
      left: 0,
      bottom: 30,
      right: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 210,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("mounts only the rows a live window can show", () => {
    const { container } = render(<VirtualActivityWindow rows={rows} windowed />);
    const viewport = container.querySelector(".session-process-window-viewport")!;
    expect(viewport).toHaveAttribute("data-windowed", "true");
    expect(viewport).toHaveStyle({ maxHeight: "210px" });
    expect(container.querySelector(".session-process-window-frame")).toHaveAttribute(
      "data-fade",
      "true",
    );
    const mounted = [...container.querySelectorAll("[data-row-key]")];
    expect(mounted.length).toBeLessThan(rows.length);
    expect(mounted[0]).toHaveAttribute("data-row-key", "row-0");
    // The tail spacer keeps the scroll range of the rows that are not mounted.
    const spacer = container.querySelector(".session-process-window-spacer");
    expect(Number.parseInt(spacer?.getAttribute("style")?.match(/height: (\d+)px/)?.[1] ?? "0", 10))
      .toBeGreaterThan(0);
  });

  it("renders finished turns in place, without a window", () => {
    const { container } = render(<VirtualActivityWindow rows={rows} />);
    expect(container.querySelectorAll("[data-row-key]")).toHaveLength(rows.length);
    expect(container.querySelector(".session-process-window-viewport"))
      .not.toHaveAttribute("data-windowed");
  });
});
