import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alignMacWindowButtons } from "./window-controls.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));

function windowMock(zoom = 1, destroyed = false) {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const methods = {
    isDestroyed: () => destroyed,
    webContents: { getZoomFactor: () => zoom },
    setWindowButtonPosition: vi.fn(),
  };
  return { win: methods as unknown as BrowserWindow, setPosition: methods.setWindowButtonPosition };
}

describe("native toolbar alignment", () => {
  it.each([[25, 1, 18], [35, 1, 28], [25, 1.5, 31]])(
    "centers traffic lights at %s with page zoom %s", (center, zoom, y) => {
      const { win, setPosition } = windowMock(zoom);
      expect(alignMacWindowButtons(win, center)).toBe(true);
      expect(setPosition).toHaveBeenCalledWith({ x: 14, y });
    },
  );
  it.each([undefined, null, "25", NaN, Infinity, -1, 257])("rejects invalid geometry %s", (value) => {
    const { win, setPosition } = windowMock();
    expect(alignMacWindowButtons(win, value)).toBe(false);
    expect(setPosition).not.toHaveBeenCalled();
  });
  it.each(["win32", "linux"])("does not call the native macOS API on %s", (value) => {
    const { win, setPosition } = windowMock();
    Object.defineProperty(process, "platform", { value });
    expect(alignMacWindowButtons(win, 25)).toBe(false);
    expect(setPosition).not.toHaveBeenCalled();
  });
  it("ignores updates after the window is destroyed", () => {
    const { win, setPosition } = windowMock(1, true);
    expect(alignMacWindowButtons(win, 25)).toBe(false);
    expect(setPosition).not.toHaveBeenCalled();
  });
});
