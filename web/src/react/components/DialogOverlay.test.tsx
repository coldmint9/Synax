import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DialogOverlay } from "./DialogOverlay";

afterEach(() => vi.unstubAllGlobals());

it("escapes a transformed host and follows the visible viewport as it shrinks or moves", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 800,
    height: 600,
    offsetTop: 0,
    offsetLeft: 0,
  });
  const remove = vi.spyOn(viewport, "removeEventListener");
  vi.stubGlobal("visualViewport", viewport);
  const view = render(
    <div style={{ transform: "translateZ(0)", overflow: "hidden", zoom: 1.5 }}>
      <DialogOverlay>
        <div role="dialog">Content</div>
      </DialogOverlay>
    </div>,
  );
  const overlay = screen.getByRole("dialog").parentElement!;
  expect(overlay.parentElement).toBe(document.body);
  expect(overlay.style.getPropertyValue("--dialog-viewport-height")).toBe(
    "600px",
  );
  act(() => {
    Object.assign(viewport, {
      width: 390,
      height: 280,
      offsetTop: 120,
      offsetLeft: 8,
    });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(overlay.style.getPropertyValue("--dialog-viewport-height")).toBe(
    "280px",
  );
  expect(overlay.style.getPropertyValue("--dialog-viewport-width")).toBe(
    "390px",
  );
  expect(overlay.style.getPropertyValue("--dialog-viewport-top")).toBe("120px");
  expect(overlay.style.getPropertyValue("--dialog-viewport-left")).toBe("8px");
  view.unmount();
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  expect(overlay.isConnected).toBe(false);
});
