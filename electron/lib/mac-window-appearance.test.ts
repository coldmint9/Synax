import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMacWindowAppearance } from "./mac-window-appearance.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

function mockWindow() {
  const methods = { setVibrancy: vi.fn(), setOpacity: vi.fn() };
  return { methods, win: methods as unknown as BrowserWindow };
}

describe("macOS window appearance API mapping", () => {
  it("maps the saved HUD setting to Electron's hud material", () => {
    const { methods, win } = mockWindow();
    const appearance = applyMacWindowAppearance(win, {
      vibrancy: "hud-window",
      opacity: 0.85,
    });
    expect(methods.setVibrancy).toHaveBeenCalledWith("hud");
    expect(methods.setOpacity).toHaveBeenCalledWith(0.85);
    expect(appearance.vibrancy).toBe("hud-window");
  });

  it("keeps the default under-window material", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, undefined);
    expect(methods.setVibrancy).toHaveBeenCalledWith("under-window");
    expect(methods.setOpacity).toHaveBeenCalledWith(0.92);
  });

  it("clears vibrancy when no material is selected", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, { vibrancy: "none" });
    expect(methods.setVibrancy).toHaveBeenCalledWith(null);
  });

  it("restores an opaque window when effects are disabled", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, { enabled: false, vibrancy: "hud-window" });
    expect(methods.setVibrancy).toHaveBeenCalledWith(null);
    expect(methods.setOpacity).toHaveBeenCalledWith(1);
  });

  it.each(["win32", "linux"])("does not call macOS window APIs on %s", (value) => {
    Object.defineProperty(process, "platform", { value });
    const { methods, win } = mockWindow();
    const appearance = applyMacWindowAppearance(win, { vibrancy: "hud-window" });
    expect(methods.setVibrancy).not.toHaveBeenCalled();
    expect(methods.setOpacity).not.toHaveBeenCalled();
    expect(appearance.vibrancy).toBe("hud-window");
  });
});
