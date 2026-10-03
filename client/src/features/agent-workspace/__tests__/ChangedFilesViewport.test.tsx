import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  CHANGED_FILES_VISIBLE_ROWS,
  ChangedFilesViewport,
} from "../ChangedFilesViewport";

const ROW_HEIGHT = 30;

function renderRows(count: number) {
  return render(
    <ChangedFilesViewport ariaLabel="变更文件">
      {Array.from({ length: count }, (_, index) => (
        <div className="ws-row" key={index}>
          file-{index}
        </div>
      ))}
    </ChangedFilesViewport>,
  );
}

function mockMeasuredLayout(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.classList.contains("ws-row") ? ROW_HEIGHT : 0;
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
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    scrollHeight,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    clientHeight,
  );
}

function viewport(container: HTMLElement) {
  return {
    scroll: container.querySelector<HTMLElement>(".ws-changes-scroll")!,
    fade: container.querySelector<HTMLElement>(".ws-changes-fade")!,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChangedFilesViewport", () => {
  it("caps the scrollport at the visible row budget and shows the bottom fade", () => {
    mockMeasuredLayout(ROW_HEIGHT * 12, ROW_HEIGHT * CHANGED_FILES_VISIBLE_ROWS);
    const { container } = renderRows(12);
    const { scroll, fade } = viewport(container);

    expect(scroll.style.maxHeight).toBe(
      `${ROW_HEIGHT * CHANGED_FILES_VISIBLE_ROWS}px`,
    );
    expect(fade).toHaveAttribute("data-visible", "true");
  });

  it("hides the fade once the list is scrolled to the end", () => {
    mockMeasuredLayout(ROW_HEIGHT * 12, ROW_HEIGHT * CHANGED_FILES_VISIBLE_ROWS);
    const { container } = renderRows(12);
    const { scroll, fade } = viewport(container);

    fireEvent.scroll(scroll, { target: { scrollTop: ROW_HEIGHT * 4 } });

    expect(fade).toHaveAttribute("data-visible", "false");
  });

  it("keeps the natural height and no fade when nothing overflows", () => {
    mockMeasuredLayout(ROW_HEIGHT * 3, ROW_HEIGHT * CHANGED_FILES_VISIBLE_ROWS);
    const { container } = renderRows(3);
    const { scroll, fade } = viewport(container);

    expect(scroll.style.maxHeight).toBe(
      `${ROW_HEIGHT * CHANGED_FILES_VISIBLE_ROWS}px`,
    );
    expect(fade).toHaveAttribute("data-visible", "false");
  });

  it("leaves layout untouched when rows cannot be measured", () => {
    const { container } = renderRows(12);
    const { scroll, fade } = viewport(container);

    expect(scroll.style.maxHeight).toBe("");
    expect(fade).toHaveAttribute("data-visible", "false");
  });
});
