import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMacWindowAppearance, windowBackgroundColor } from "./mac-window-appearance.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

function mockWindow() {
  const methods = { setVibrancy: vi.fn(), setOpacity: vi.fn(), setBackgroundColor: vi.fn() };
  return { methods, win: methods as unknown as BrowserWindow };
}

describe("macOS window appearance API mapping", () => {
  it.each([false, true])("theme sync leaves an enabled window clear (dark=%s)", (dark) => {
    expect(windowBackgroundColor({ enabled: true }, dark)).toBe("#00000000");
    expect(windowBackgroundColor({ enabled: false }, dark)).toBe(dark ? "#0f141d" : "#f9f9f9");
  });

  it("restores the active dark backing when effects are disabled", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, { enabled: true }, true);
    expect(methods.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    applyMacWindowAppearance(win, { enabled: false }, true);
    expect(methods.setBackgroundColor).toHaveBeenLastCalledWith("#0f141d");
  });

  it("maps the saved HUD setting to Electron's hud material", () => {
    const { methods, win } = mockWindow();
    const appearance = applyMacWindowAppearance(win, {
      enabled: true,
      vibrancy: "hud-window",
      opacity: 0.85,
    });
    expect(methods.setVibrancy).toHaveBeenCalledWith("hud");
    expect(methods.setOpacity).toHaveBeenCalledWith(1);
    expect(methods.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(appearance.vibrancy).toBe("hud-window");
  });

  it("disables the native material by default", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, undefined);
    expect(methods.setVibrancy).toHaveBeenCalledWith(null);
    expect(methods.setOpacity).toHaveBeenCalledWith(1);
  });

  it("keeps content opaque while changing the background concentration", () => {
    const { methods, win } = mockWindow();
    applyMacWindowAppearance(win, { enabled: true, opacity: 0.35 });
    expect(methods.setVibrancy).toHaveBeenCalledWith("under-window");
    expect(methods.setOpacity).toHaveBeenCalledWith(1);
  });

  it("clamps unsupported concentration values", () => {
    const { methods, win } = mockWindow();
    const appearance = applyMacWindowAppearance(win, { opacity: -1 });
    expect(appearance.opacity).toBe(0.35);
    expect(methods.setOpacity).toHaveBeenCalledWith(1);
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
    expect(methods.setBackgroundColor).not.toHaveBeenCalled();
    expect(windowBackgroundColor({ enabled: true }, false)).toBe("#f9f9f9");
    expect(appearance.vibrancy).toBe("hud-window");
  });
});
